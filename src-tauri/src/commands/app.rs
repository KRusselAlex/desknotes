use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};

use crate::error::IpcResult;
use crate::state::AppState;
use crate::windows::{self, APP_WILL_QUIT, QUIT_BLOCKED};

/// How long quitting waits for note windows to confirm they saved.
const QUIT_TIMEOUT: Duration = Duration::from_secs(4);

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
pub fn quit_app(app: AppHandle, state: State<'_, AppState>) {
    let labels = windows::open_note_labels(&app);
    if labels.is_empty() {
        app.exit(0);
        return;
    }
    state.quit.begin(labels);
    let _ = app.emit(APP_WILL_QUIT, ());
    std::thread::spawn(move || {
        let unsaved = app.state::<AppState>().quit.wait(QUIT_TIMEOUT);
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

/// A note window's answer to `app-will-quit`: whether all its text is saved.
#[tauri::command]
pub fn quit_ready(window: WebviewWindow, state: State<'_, AppState>, saved: bool) {
    state.quit.report(window.label(), saved);
}
