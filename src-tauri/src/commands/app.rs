use std::time::Duration;

use tauri::{AppHandle, Emitter, State, WebviewWindow};

use crate::error::IpcResult;
use crate::state::AppState;
use crate::windows::{self, QUIT_BLOCKED};

/// How long quitting, exporting and restoring wait for note windows to save.
pub const SAVE_TIMEOUT: Duration = Duration::from_secs(4);

#[tauri::command]
pub async fn show_manager(app: AppHandle) -> IpcResult<()> {
    Ok(windows::show_manager(&app)?)
}

/// Problems found at startup, for the manager to display.
#[tauri::command]
pub fn startup_errors(state: State<'_, AppState>) -> Vec<String> {
    state.errors()
}

/// Ask every note window to save, and exit only when all of them did.
/// If any note still holds unsaved text, quitting is cancelled and the
/// manager explains why, so nothing is lost silently.
#[tauri::command]
pub fn quit_app(app: AppHandle) {
    std::thread::spawn(move || {
        let unsaved = windows::save_all_open_notes(&app, SAVE_TIMEOUT);
        if unsaved == 0 {
            app.exit(0);
        } else {
            if let Err(e) = windows::show_manager(&app) {
                eprintln!("DeskNotes: could not show the manager: {e}");
            }
            let _ = app.emit(QUIT_BLOCKED, unsaved);
        }
    });
}

/// A note window's answer to `save-all-notes`: whether all its text is saved.
#[tauri::command]
pub fn quit_ready(window: WebviewWindow, state: State<'_, AppState>, saved: bool) {
    state.quit.report(window.label(), saved);
}
