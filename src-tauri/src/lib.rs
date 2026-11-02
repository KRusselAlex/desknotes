//! DeskNotes desktop adapter: Tauri commands, windows and platform code
//! around the platform-independent `desknotes-core` crate (ADR-0001).

mod commands;
mod error;
pub mod platform;
mod quit;
mod state;
mod tray;
mod windows;

use tauri::{Manager, RunEvent};

use crate::state::AppState;

/// Command-line flag for the show / hide all keyboard shortcut (DES-27).
pub const TOGGLE_NOTES_ARG: &str = "--toggle-notes";

pub fn run() {
    let app = tauri::Builder::default()
        // Must be registered first. A second launch hands its arguments to this
        // one: `--toggle-notes` (the show / hide all shortcut) hides or shows the
        // notes; anything else just shows the manager.
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            if argv.iter().any(|a| a == TOGGLE_NOTES_ARG) {
                tray::spawn_notes_action(app, commands::notes::toggle_notes);
            } else if let Err(e) = windows::show_manager(app) {
                eprintln!("DeskNotes: could not show the manager: {e}");
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .setup(|app| {
            let handle = app.handle().clone();
            app.manage(AppState::open(&handle));
            windows::restore_on_startup(&handle);
            tray::install(&handle);
            Ok(())
        })
        .on_window_event(windows::on_window_event)
        .invoke_handler(tauri::generate_handler![
            commands::notes::list_notes,
            commands::notes::note_counts,
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
            commands::notes::set_always_on_top,
            commands::notes::set_collapsed,
            commands::notes::hide_all_notes,
            commands::notes::show_hidden_notes,
            commands::notes::hidden_note_count,
            commands::app::show_manager,
            commands::app::startup_errors,
            commands::app::quit_app,
            commands::app::quit_ready,
            commands::settings::open_settings,
            commands::settings::get_settings,
            commands::settings::set_launch_at_login,
            commands::settings::set_new_note_color,
            commands::settings::get_toggle_shortcut,
            commands::settings::set_toggle_shortcut,
            commands::settings::remove_toggle_shortcut,
            commands::settings::set_min_note_size,
            commands::settings::open_data_folder,
            commands::backup::export_backup,
            commands::backup::choose_backup,
            commands::backup::cancel_restore,
            commands::backup::restore_backup,
        ])
        .build(tauri::generate_context!())
        .expect("DeskNotes failed to start");

    app.run(|app, event| {
        if let RunEvent::Exit = event
            && let Some(state) = app.try_state::<AppState>()
        {
            state.geometry.flush();
        }
    });
}
