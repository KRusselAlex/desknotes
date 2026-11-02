//! Privacy lock orchestration (design §4.3, §4.5): saving before locking,
//! locking and unlocking, and telling the windows. The core enforces the lock;
//! this module decides when it changes. PINs and codes are never logged.

use std::collections::HashSet;
use std::sync::Mutex;
use std::sync::atomic::Ordering;

use desknotes_core::now_ms;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::commands::app::SAVE_TIMEOUT;
use crate::error::IpcResult;
use crate::platform::lock_triggers::inactive_long_enough;
use crate::state::AppState;
use crate::windows::{self, emit_changed};

/// Sent to all windows when the lock turns on or off, and to one note window
/// when its note, kept open at the last lock, is now locked too.
pub const PRIVACY_CHANGED: &str = "privacy-changed";

/// Payload of `privacy-changed`.
#[derive(Clone, Serialize)]
pub struct PrivacyChanged {
    pub locked: bool,
}

/// How a forgotten PIN can be replaced here (design D5, D6).
pub fn recovery_mode(system_auth: bool, has_recovery_code: bool) -> &'static str {
    if system_auth {
        "system"
    } else if has_recovery_code {
        "code"
    } else {
        "none"
    }
}

/// The private notes among those whose windows could not confirm saving: they
/// stay readable and savable after the lock until their text is saved, so
/// nothing typed is lost (design §4.3).
pub fn keep_open_ids(not_saved: &[String], private_ids: &HashSet<String>) -> Vec<String> {
    let mut kept: Vec<String> = not_saved
        .iter()
        .filter(|id| private_ids.contains(*id))
        .cloned()
        .collect();
    kept.sort();
    kept.dedup();
    kept
}

/// Tell every window that the lock turned on or off.
pub fn emit_privacy_changed(app: &AppHandle, locked: bool) {
    if let Err(e) = app.emit(PRIVACY_CHANGED, PrivacyChanged { locked }) {
        eprintln!("DeskNotes: could not notify windows of the lock: {e}");
    }
    // The manager's list shows locked rows differently.
    emit_changed(app, None, "other");
}

/// Lock private notes: every open note saves first; a private note that could
/// not save (or did not answer) stays open until its next save. No-op without
/// a PIN. Blocking (waits for the note windows): never call it on the main thread.
pub fn lock(app: &AppHandle) -> IpcResult<()> {
    let state = app.state::<AppState>();
    if !state.with_db(|db| db.pin_is_set())? {
        return Ok(());
    }
    let outcome = windows::save_all_open_notes_detailed(app, SAVE_TIMEOUT);
    let not_saved: Vec<String> = outcome.unsaved.into_iter().chain(outcome.silent).collect();
    state.with_db(|db| {
        // A note that cannot be read is treated as private: keeping a normal
        // note in the list changes nothing, dropping a private one could lose text.
        let private: HashSet<String> = not_saved
            .iter()
            .filter(|id| db.get_note(id).map(|n| n.private).unwrap_or(true))
            .cloned()
            .collect();
        db.set_privacy_locked(true, &keep_open_ids(&not_saved, &private));
        Ok(())
    })?;
    // A proof of identity given before the lock (Task 7) does not outlive it.
    state.new_pin_allowed.store(false, Ordering::Release);
    emit_privacy_changed(app, true);
    Ok(())
}

/// Run [`lock`] on another thread (from the main thread: tray, D-Bus signals).
/// A failure opens the manager with the reason.
pub fn spawn_lock(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        if let Err(e) = lock(&app) {
            eprintln!(
                "DeskNotes: private notes could not be locked: {}",
                e.message
            );
            crate::tray::report(&app, e.message);
        }
    });
}

/// Serialises automatic locks: a second trigger for the same event (the screen
/// saver and logind both report a screen lock) waits here, then finds the lock
/// already on and does nothing.
static AUTO_LOCK: Mutex<()> = Mutex::new(());

/// Whether an automatic trigger should lock: a PIN is set and the lock is not
/// already in effect.
pub fn auto_lock_needed(pin_set: bool, locked: bool) -> bool {
    pin_set && !locked
}

/// Lock because of sleep, a screen lock or inactivity. Blocking (waits for the
/// note windows): call it from a watcher thread, never the main thread.
/// Returns false when locking failed; the manager is told why.
pub fn lock_automatically(app: &AppHandle) -> bool {
    let _one_at_a_time = AUTO_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let state = app.state::<AppState>();
    let needed = state
        .with_db(|db| Ok(auto_lock_needed(db.pin_is_set()?, db.privacy_locked())))
        .unwrap_or(false);
    if !needed {
        return true;
    }
    match lock(app) {
        Ok(()) => true,
        Err(e) => {
            eprintln!(
                "DeskNotes: private notes could not be locked: {}",
                e.message
            );
            crate::tray::report(app, e.message);
            false
        }
    }
}

/// The inactivity check: lock when the notes are unlocked and no DeskNotes
/// window has reported input for the chosen number of minutes.
pub fn lock_if_inactive(app: &AppHandle) {
    let state = app.state::<AppState>();
    let minutes = state.with_db(|db| {
        Ok(if auto_lock_needed(db.pin_is_set()?, db.privacy_locked()) {
            Some(db.lock_after_minutes()?)
        } else {
            None
        })
    });
    let Ok(Some(minutes)) = minutes else { return };
    let last = state.last_activity_ms.load(Ordering::Relaxed);
    if inactive_long_enough(now_ms(), last, minutes) && !lock_automatically(app) {
        // Do not report the same failure every check: try again after a full period.
        state.touch_activity();
    }
}

/// A note kept open at the last lock has saved, or its window closed: lock it
/// now and tell its window (if any) to show the locked view.
pub fn release_kept_open(app: &AppHandle, id: &str) {
    let state = app.state::<AppState>();
    let now_locked = state.with_db(|db| {
        if !db.privacy_locked() {
            return Ok(false);
        }
        let was_locked = db.is_note_locked(id)?;
        db.release_kept_open(id);
        Ok(!was_locked && db.is_note_locked(id)?)
    });
    match now_locked {
        Ok(true) => {
            let label = windows::note_label(id);
            if app.get_webview_window(&label).is_some() {
                let _ = app.emit_to(
                    label.as_str(),
                    PRIVACY_CHANGED,
                    PrivacyChanged { locked: true },
                );
            }
            emit_changed(app, Some(id), "other");
        }
        Ok(false) => {}
        // A missing note (purged meanwhile) has nothing to lock.
        Err(e) if e.code == "not_found" => {}
        Err(e) => eprintln!(
            "DeskNotes: a kept-open note could not be locked: {}",
            e.message
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ids(names: &[&str]) -> Vec<String> {
        names.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn automatic_locks_need_a_pin_and_an_unlocked_state() {
        assert!(auto_lock_needed(true, false));
        assert!(!auto_lock_needed(false, false), "no PIN, nothing to lock");
        assert!(!auto_lock_needed(true, true), "already locked");
        assert!(!auto_lock_needed(false, true));
    }

    #[test]
    fn unsaved_private_ids_are_kept_open() {
        let private: HashSet<String> = ids(&["b", "c", "d"]).into_iter().collect();
        // "a" is not private: it does not need to stay open. "d" saved.
        assert_eq!(
            keep_open_ids(&ids(&["c", "a", "b", "c"]), &private),
            ids(&["b", "c"])
        );
        assert!(keep_open_ids(&[], &private).is_empty());
        assert!(keep_open_ids(&ids(&["a"]), &HashSet::new()).is_empty());
    }

    #[test]
    fn status_reports_recovery_mode() {
        assert_eq!(recovery_mode(true, true), "system");
        assert_eq!(recovery_mode(true, false), "system");
        assert_eq!(recovery_mode(false, true), "code");
        assert_eq!(recovery_mode(false, false), "none");
    }
}
