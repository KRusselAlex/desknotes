use std::time::Duration;

use tauri::{AppHandle, Emitter, State};

use crate::error::IpcResult;
use crate::state::AppState;
use crate::windows::{self, APP_WILL_QUIT};

#[tauri::command]
pub async fn show_manager(app: AppHandle) -> IpcResult<()> {
    Ok(windows::show_manager(&app)?)
}

/// Problems found at startup, for the manager to display.
#[tauri::command]
pub fn startup_errors(state: State<'_, AppState>) -> Vec<String> {
    state.errors()
}

/// Ask note windows to flush unsaved text, then exit.
#[tauri::command]
pub fn quit_app(app: AppHandle) {
    let _ = app.emit(APP_WILL_QUIT, ());
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(300));
        app.exit(0);
    });
}
