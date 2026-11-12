use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use desknotes_core::{CoreError, CoreResult, Database, now_ms};
use tauri::{AppHandle, Emitter, EventTarget, Manager, Runtime};

use crate::automation::PendingResets;
use crate::error::{IpcError, IpcResult};
use crate::quit::QuitCoordinator;
use crate::windows::geometry::GeometryWriter;

/// The notes database, `None` when it could not be opened at startup.
pub type SharedDb = Mutex<Option<Database>>;

/// Run `f` with the database, mapping every failure to an IPC error.
pub fn with_db<T>(db: &SharedDb, f: impl FnOnce(&Database) -> CoreResult<T>) -> IpcResult<T> {
    let guard = db
        .lock()
        .map_err(|_| IpcError::new("internal", "database lock poisoned"))?;
    let db = guard
        .as_ref()
        .ok_or_else(|| IpcError::new(DATABASE_UNAVAILABLE, "the notes database is not open"))?;
    Ok(f(db)?)
}

pub struct AppState {
    db: Arc<SharedDb>,
    /// Problems found at startup or reported later, shown in the manager.
    startup_errors: ErrorList,
    pub geometry: GeometryWriter,
    pub quit: QuitCoordinator,
    /// A validated backup chosen in the restore dialog, waiting for confirmation.
    pub pending_restore: Mutex<Option<PendingRestore>>,
    /// Whether the tray icon was created (the desktop may not support one).
    tray: AtomicBool,
    /// A hide / show of all notes is running (tray or shortcut).
    notes_action: AtomicBool,
    /// Last input reported by any DeskNotes window (Unix ms), for the
    /// inactivity lock. Refreshed by `report_activity` and `unlock`.
    pub last_activity_ms: AtomicI64,
    /// One-shot permission to choose a new PIN without the current one, set
    /// only after the Ubuntu password or a recovery code was accepted (Task 7).
    pub new_pin_allowed: AtomicBool,
    /// Taken for the whole of any work that hashes a PIN or recovery code, which
    /// runs with the database lock released: checks take turns, so the wrong-PIN
    /// waits cannot be raced past, and the PIN cannot change during one.
    pub secrets: Mutex<()>,
    /// Counts locks. An unlock or a proof of a forgotten PIN compares it before and
    /// after its check: a lock that came during the check wins.
    pub lock_epoch: AtomicU64,
    /// Checklist resets (automation rule 2) sent to open note windows, waiting
    /// for their editor to claim them.
    pub pending_resets: PendingResets,
    /// Ids of the notes whose open window was created transparent (below 100 %
    /// opacity). Kept by `windows`: a window's transparency cannot be read back.
    pub see_through: Mutex<HashSet<String>>,
}

/// The notes database inside the app data folder.
pub const DB_FILE: &str = "desknotes.db";
/// Pre-migration backups, next to the database.
pub const BACKUP_DIR: &str = "backups";

/// Error code of [`AppState::with_db`] when the database never opened
/// (already reported at startup).
pub const DATABASE_UNAVAILABLE: &str = "database_unavailable";

pub struct PendingRestore {
    pub backup: desknotes_core::backup::Backup,
}

/// The plain message shown when a database was saved by a newer DeskNotes.
const NEWER_DATABASE_MESSAGE: &str = "Your notes were saved by a newer version of DeskNotes. Install that version (or newer) to open them; nothing was changed.";

/// What the manager shows when the notes database cannot be opened at startup.
/// Never includes note text.
pub fn startup_message(e: &CoreError) -> String {
    match e {
        CoreError::SchemaTooNew { .. } => NEWER_DATABASE_MESSAGE.to_string(),
        other => format!("The notes database could not be opened: {other}"),
    }
}

impl AppState {
    pub fn open(app: &AppHandle) -> Self {
        let mut errors = Vec::new();
        let db = match app.path().app_data_dir() {
            Ok(dir) => match Database::open(&dir.join(DB_FILE), &dir.join(BACKUP_DIR)) {
                Ok(db) => {
                    // Start-up only, never during a session: undo and a fresh paste
                    // may still need an image no note uses yet.
                    match db.remove_unused_images() {
                        Ok(0) => {}
                        Ok(n) => eprintln!("DeskNotes: removed {n} unused image(s)"),
                        Err(e) => eprintln!("DeskNotes: could not remove unused images: {e}"),
                    }
                    Some(db)
                }
                Err(e) => {
                    errors.push(startup_message(&e));
                    None
                }
            },
            Err(e) => {
                errors.push(format!("No application data folder is available: {e}"));
                None
            }
        };
        for e in &errors {
            eprintln!("DeskNotes: {e}");
        }
        // DeskNotes starts locked whenever a PIN is set, before any window
        // can ask for a note (design §4.3). If the PIN setting cannot be read,
        // lock anyway: the core only applies the lock while a PIN exists.
        if let Some(db) = &db {
            db.set_privacy_locked(db.pin_is_set().unwrap_or(true), &[]);
        }
        let db = Arc::new(Mutex::new(db));
        Self {
            geometry: GeometryWriter::spawn(db.clone()),
            db,
            startup_errors: ErrorList::new(errors),
            quit: QuitCoordinator::default(),
            pending_restore: Mutex::new(None),
            tray: AtomicBool::new(false),
            notes_action: AtomicBool::new(false),
            last_activity_ms: AtomicI64::new(now_ms()),
            new_pin_allowed: AtomicBool::new(false),
            secrets: Mutex::new(()),
            lock_epoch: AtomicU64::new(0),
            pending_resets: PendingResets::default(),
            see_through: Mutex::new(HashSet::new()),
        }
    }

    /// Run `f` with the database, mapping every failure to an IPC error.
    pub fn with_db<T>(&self, f: impl FnOnce(&Database) -> CoreResult<T>) -> IpcResult<T> {
        with_db(&self.db, f)
    }

    pub fn db(&self) -> &SharedDb {
        &self.db
    }

    pub fn set_tray_available(&self, available: bool) {
        self.tray.store(available, Ordering::Relaxed);
    }

    pub fn tray_available(&self) -> bool {
        self.tray.load(Ordering::Relaxed)
    }

    /// Claim the single slot for a hide / show of all notes. False when one is
    /// already running: two at once could forget which notes were hidden.
    pub fn begin_notes_action(&self) -> bool {
        !self.notes_action.swap(true, Ordering::AcqRel)
    }

    /// Remember that the person used DeskNotes just now.
    pub fn touch_activity(&self) {
        self.last_activity_ms.store(now_ms(), Ordering::Relaxed);
    }

    pub fn end_notes_action(&self) {
        self.notes_action.store(false, Ordering::Release);
    }

    /// Add a problem for the manager to show, and tell an open manager.
    pub fn push_error(&self, app: &AppHandle, message: String) {
        self.startup_errors.push(app, message);
    }

    pub fn errors(&self) -> Vec<String> {
        self.startup_errors.all()
    }
}

/// Sent to the manager each time a problem is added to the error list. The payload is
/// the whole list, oldest first; the list only grows, so a longer one is newer.
pub const ERRORS_CHANGED: &str = "errors-changed";

/// Problems for the manager to show, oldest first. Never contains note text.
/// Problems are only ever added: the manager hides the ones Retry dismissed.
pub struct ErrorList(Mutex<Vec<String>>);

impl ErrorList {
    pub fn new(errors: Vec<String>) -> Self {
        Self(Mutex::new(errors))
    }

    /// Add `message` and send the new list to the manager. The manager also reads the
    /// list when it opens, so a problem added before it exists is not lost.
    pub fn push<R: Runtime>(&self, app: &impl Emitter<R>, message: String) {
        eprintln!("DeskNotes: {message}");
        let Ok(mut errors) = self.0.lock() else {
            return;
        };
        errors.push(message);
        let all = errors.clone();
        drop(errors);
        let manager = EventTarget::webview_window(crate::windows::MANAGER);
        if let Err(e) = app.emit_to(manager, ERRORS_CHANGED, all) {
            eprintln!("DeskNotes: could not tell the manager about a problem: {e}");
        }
    }

    pub fn all(&self) -> Vec<String> {
        self.0.lock().map(|e| e.clone()).unwrap_or_default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tauri::{Listener, WebviewUrl, WebviewWindowBuilder};

    #[test]
    fn a_new_problem_sends_the_whole_list_to_the_manager_only() {
        let app = tauri::test::mock_app();
        let manager =
            WebviewWindowBuilder::new(&app, crate::windows::MANAGER, WebviewUrl::default())
                .build()
                .unwrap();
        let note = WebviewWindowBuilder::new(&app, "note-abc", WebviewUrl::default())
            .build()
            .unwrap();
        let to_manager = Arc::new(Mutex::new(Vec::new()));
        let to_note = Arc::new(Mutex::new(Vec::new()));
        let sink = to_manager.clone();
        manager.listen(ERRORS_CHANGED, move |e| {
            sink.lock().unwrap().push(e.payload().to_string())
        });
        let sink = to_note.clone();
        note.listen(ERRORS_CHANGED, move |e| {
            sink.lock().unwrap().push(e.payload().to_string())
        });

        let list = ErrorList::new(vec!["Found at startup".into()]);
        list.push(
            &app,
            "The Settings window could not be opened: no display".into(),
        );

        assert_eq!(
            list.all(),
            [
                "Found at startup",
                "The Settings window could not be opened: no display"
            ]
        );
        assert_eq!(
            *to_manager.lock().unwrap(),
            [r#"["Found at startup","The Settings window could not be opened: no display"]"#]
        );
        assert!(to_note.lock().unwrap().is_empty());
    }

    #[test]
    fn newer_database_message() {
        let newer = CoreError::SchemaTooNew {
            found: 9,
            supported: 4,
        };
        assert_eq!(
            startup_message(&newer),
            "Your notes were saved by a newer version of DeskNotes. Install that version (or newer) to open them; nothing was changed."
        );

        let other = CoreError::NotAllowed("refusing to overwrite".into());
        assert_eq!(
            startup_message(&other),
            format!("The notes database could not be opened: {other}")
        );
    }
}
