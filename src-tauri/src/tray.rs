//! Tray icon (AppIndicator on Ubuntu): quick actions without opening a window.
//! Menu events run on the main thread; anything that waits for note windows
//! runs on another thread so the windows can answer.

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager};

use crate::commands::{app as app_cmd, notes};
use crate::state::AppState;
use crate::windows;

/// Sent to the manager when an action started from the tray failed.
pub const ACTION_FAILED: &str = "action-failed";

pub fn create(app: &AppHandle) -> tauri::Result<()> {
    let item = |id: &str, label: &str| MenuItem::with_id(app, id, label, true, None::<&str>);
    let menu = Menu::with_items(
        app,
        &[
            &item("new", "New note")?,
            &item("hide_all", "Hide all notes")?,
            &item("show_hidden", "Show hidden notes")?,
            &PredefinedMenuItem::separator(app)?,
            &item("manager", "Open manager")?,
            &item("settings", "Settings…")?,
            &PredefinedMenuItem::separator(app)?,
            &item("quit", "Quit DeskNotes")?,
        ],
    )?;
    let mut builder = TrayIconBuilder::with_id("main")
        .tooltip("DeskNotes")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| on_menu(app, event.id().as_ref()));
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}

fn report(app: &AppHandle, message: String) {
    let _ = windows::show_manager(app);
    let _ = app.emit(ACTION_FAILED, message);
}

fn on_menu(app: &AppHandle, id: &str) {
    match id {
        "new" => {
            if let Err(e) = notes::new_note(app) {
                report(app, e.message);
            }
        }
        "hide_all" | "show_hidden" => {
            let app = app.clone();
            let hide = id == "hide_all";
            std::thread::spawn(move || {
                let result = if hide {
                    notes::hide_all(&app)
                } else {
                    notes::show_hidden(&app)
                };
                if let Err(e) = result {
                    report(&app, e.message);
                }
            });
        }
        "manager" => {
            let _ = windows::show_manager(app);
        }
        "settings" => {
            let _ = windows::open_settings(app);
        }
        "quit" => app_cmd::request_quit(app.clone()),
        _ => {}
    }
}

/// Create the tray icon; remember whether it worked so "Hide all notes" never
/// leaves the user without a way back.
pub fn install(app: &AppHandle) {
    let ok = match create(app) {
        Ok(()) => true,
        Err(e) => {
            eprintln!("DeskNotes: no tray icon ({e}); the manager stays the way back");
            false
        }
    };
    app.state::<AppState>().set_tray_available(ok);
}
