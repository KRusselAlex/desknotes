//! DeskNotes desktop adapter: Tauri commands, windows and platform code
//! around the platform-independent `desknotes-core` crate (ADR-0001).

mod commands;
mod error;
pub mod platform;
mod state;
mod windows;

use tauri::{Manager, RunEvent};

use crate::state::AppState;

pub fn run() {
    let app = tauri::Builder::default()
        // Must be registered first: a second launch just shows the manager.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Err(e) = windows::show_manager(app) {
                eprintln!("DeskNotes: could not show the manager: {e}");
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let handle = app.handle().clone();
            app.manage(AppState::open(&handle));
            windows::restore_on_startup(&handle);
            Ok(())
        })
        .on_window_event(windows::on_window_event)
        .invoke_handler(tauri::generate_handler![
            commands::notes::list_notes,
            commands::notes::get_note,
            commands::notes::create_note,
            commands::notes::save_note_content,
            commands::notes::set_note_color,
            commands::notes::duplicate_note,
            commands::notes::set_archived,
            commands::notes::trash_note,
            commands::notes::restore_note,
            commands::notes::purge_note,
            commands::notes::show_note,
            commands::notes::hide_note,
            commands::notes::set_edit_locked,
            commands::app::show_manager,
            commands::app::startup_errors,
            commands::app::quit_app,
        ])
        .build(tauri::generate_context!())
        .expect("DeskNotes failed to start");

    app.run(|app, event| {
        if let RunEvent::Exit = event {
            if let Some(state) = app.try_state::<AppState>() {
                state.geometry.flush();
            }
        }
    });
}
