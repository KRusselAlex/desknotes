//! Tray icon (AppIndicator on Ubuntu): quick actions without opening a window.
//! Menu events run on the main thread; anything that waits for note windows
//! runs on another thread so the windows can answer.

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager};

use crate::commands::{app as app_cmd, notes};
use crate::error::IpcResult;
use crate::privacy;
use crate::state::AppState;
use crate::windows;

/// Sent to the manager when an action started from the tray failed.
pub const ACTION_FAILED: &str = "action-failed";

const TRAY_ID: &str = "main";

/// The tray menu. "Lock now" is there only while a PIN is set.
fn build_menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let item = |id: &str, label: &str| MenuItem::with_id(app, id, label, true, None::<&str>);
    let pin_set = app
        .state::<AppState>()
        .with_db(|db| db.pin_is_set())
        .unwrap_or(false);
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
    if pin_set {
        menu.insert(&item("lock", "Lock now")?, 3)?;
    }
    Ok(menu)
}

/// Rebuild the tray menu after the PIN was set up or removed.
pub fn refresh(app: &AppHandle) {
    let Some(tray) = app.tray_by_id(TRAY_ID) else {
        return;
    };
    if let Err(e) = build_menu(app).and_then(|menu| tray.set_menu(Some(menu))) {
        eprintln!("DeskNotes: could not update the tray menu: {e}");
    }
}

pub fn create(app: &AppHandle) -> tauri::Result<()> {
    let menu = build_menu(app)?;
    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
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

pub fn report(app: &AppHandle, message: String) {
    let _ = windows::show_manager(app);
    let _ = app.emit(ACTION_FAILED, message);
}

/// Run a hide/show action off the main thread (it waits for the notes to save).
/// One at a time: a second press while one runs is ignored. A failure opens the
/// manager with the reason.
pub fn spawn_notes_action<T: 'static>(app: &AppHandle, action: fn(&AppHandle) -> IpcResult<T>) {
    if !app.state::<AppState>().begin_notes_action() {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        let result = action(&app);
        app.state::<AppState>().end_notes_action();
        if let Err(e) = result {
            report(&app, e.message);
        }
    });
}

fn on_menu(app: &AppHandle, id: &str) {
    match id {
        "new" => {
            if let Err(e) = notes::new_note(app) {
                report(app, e.message);
            }
        }
        "hide_all" => spawn_notes_action(app, notes::hide_all),
        "show_hidden" => spawn_notes_action(app, notes::show_hidden),
        "lock" => privacy::spawn_lock(app),
        "manager" => {
            let _ = windows::show_manager(app);
        }
        "settings" => {
            let _ = windows::open_settings(app, None);
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
