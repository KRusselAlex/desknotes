use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::{Arc, Mutex};

use desknotes_core::{CoreError, CoreResult, Database, now_ms};
use tauri::{AppHandle, Manager};

use crate::error::{IpcError, IpcResult};
use crate::quit::QuitCoordinator;
use crate::windows::geometry::GeometryWriter;

pub struct AppState {
    db: Arc<Mutex<Option<Database>>>,
    /// Problems found at startup, shown in the manager. Never contains note text.
    startup_errors: Mutex<Vec<String>>,
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
            startup_errors: Mutex::new(errors),
            quit: QuitCoordinator::default(),
            pending_restore: Mutex::new(None),
            tray: AtomicBool::new(false),
            notes_action: AtomicBool::new(false),
            last_activity_ms: AtomicI64::new(now_ms()),
            new_pin_allowed: AtomicBool::new(false),
        }
    }

    /// Run `f` with the database, mapping every failure to an IPC error.
    pub fn with_db<T>(&self, f: impl FnOnce(&Database) -> CoreResult<T>) -> IpcResult<T> {
        let guard = self
            .db
            .lock()
            .map_err(|_| IpcError::new("internal", "database lock poisoned"))?;
        let db = guard
            .as_ref()
            .ok_or_else(|| IpcError::new(DATABASE_UNAVAILABLE, "the notes database is not open"))?;
        Ok(f(db)?)
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

    pub fn push_error(&self, message: String) {
        eprintln!("DeskNotes: {message}");
        if let Ok(mut errors) = self.startup_errors.lock() {
            errors.push(message);
        }
    }

    pub fn errors(&self) -> Vec<String> {
        self.startup_errors
            .lock()
            .map(|e| e.clone())
            .unwrap_or_default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
