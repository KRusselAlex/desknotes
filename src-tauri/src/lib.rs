//! DeskNotes desktop adapter: Tauri commands, windows and platform code
//! around the platform-independent `desknotes-core` crate (ADR-0001).

mod automation;
mod commands;
mod error;
pub mod platform;
mod privacy;
mod quit;
mod reminders;
mod reset_pin;
mod state;
mod tray;
mod windows;

use tauri::{Manager, RunEvent};

use crate::state::AppState;

/// Command-line flag for the show / hide all keyboard shortcut (DES-27).
pub const TOGGLE_NOTES_ARG: &str = "--toggle-notes";

/// Lock private notes on sleep, screen lock and inactivity (design D3), and wake
/// the reminder scheduler on resume. Each watcher has its own thread; none can stop
/// or slow the app.
fn start_lock_triggers(app: &tauri::AppHandle) {
    let on_event = app.clone();
    let on_resume = app.clone();
    platform::lock_triggers::watch(
        move || {
            privacy::lock_automatically(&on_event);
        },
        move || reminders::wake(&on_resume),
    );
    let on_tick = app.clone();
    platform::lock_triggers::watch_inactivity(move || privacy::lock_if_inactive(&on_tick));
}

pub fn run() {
    // `desknotes --reset-pin` (design D11) works in the terminal only: it must
    // not start the app, open a window or reach a running DeskNotes.
    if reset_pin::requested(std::env::args_os()) {
        std::process::exit(reset_pin::run());
    }
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
            // Opening the state also turns the privacy lock on when a PIN is set,
            // before any note window can ask for its text.
            app.manage(AppState::open(&handle));
            // Rules 3 and 4 (DES-42) once before any window shows, then hourly.
            automation::start(&handle);
            windows::restore_on_startup(&handle);
            tray::install(&handle);
            // After the manager exists: a click on a notification may open a note.
            reminders::start(&handle);
            start_lock_triggers(&handle);
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
            commands::notes::set_note_completed,
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
            commands::note_settings::set_note_appearance,
            commands::note_settings::set_note_size,
            commands::note_settings::list_fonts,
            commands::note_settings::open_note_settings,
            commands::note_settings::reopen_note,
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
            commands::settings::get_app_appearance,
            commands::settings::set_app_appearance,
            commands::settings::set_automations,
            commands::settings::count_purgeable,
            commands::settings::open_data_folder,
            commands::settings::open_external_link,
            commands::backup::export_backup,
            commands::backup::choose_backup,
            commands::backup::cancel_restore,
            commands::backup::restore_backup,
            commands::privacy::privacy_status,
            commands::privacy::unlock,
            commands::privacy::lock_now,
            commands::privacy::setup_pin,
            commands::privacy::change_pin,
            commands::privacy::turn_off_lock,
            commands::privacy::set_recovery_method,
            commands::privacy::set_lock_after,
            commands::privacy::set_note_private,
            commands::privacy::report_activity,
            commands::privacy::acknowledge_pin_reset,
            commands::privacy::forgot_pin_system,
            commands::privacy::recover_with_code,
            commands::privacy::choose_new_pin,
            commands::reminders::get_reminder,
            commands::reminders::set_reminder,
            commands::reminders::remove_reminder,
            commands::reminders::list_reminders,
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
