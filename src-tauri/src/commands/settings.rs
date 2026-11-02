use desknotes_core::CoreError;
use serde::Serialize;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_autostart::ManagerExt as _;
use tauri_plugin_opener::OpenerExt as _;

use crate::error::{IpcError, IpcResult};
use crate::state::AppState;
use crate::windows::{self, emit_changed};

/// Everything the Settings window shows.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsView {
    pub launch_at_login: bool,
    pub new_note_color: String,
    pub version: String,
    pub data_dir: String,
    /// Time of the last successful export (Unix ms), if any.
    pub last_backup_at: Option<i64>,
}

#[tauri::command]
pub async fn open_settings(app: AppHandle) -> IpcResult<()> {
    Ok(windows::open_settings(&app)?)
}

#[tauri::command]
pub fn get_settings(app: AppHandle, state: State<'_, AppState>) -> IpcResult<SettingsView> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map(|p| p.display().to_string())
        .unwrap_or_default();
    Ok(SettingsView {
        // If the launcher state cannot be read, show it as off rather than failing.
        launch_at_login: app.autolaunch().is_enabled().unwrap_or(false),
        new_note_color: state.with_db(|db| db.new_note_color())?,
        version: app.package_info().version.to_string(),
        data_dir,
        last_backup_at: state
            .with_db(|db| db.get_setting(desknotes_core::db::LAST_BACKUP_AT))?
            .and_then(|v| v.parse().ok()),
    })
}

/// Start DeskNotes when the user logs in. On Linux this writes or removes a
/// standard entry in ~/.config/autostart.
#[tauri::command]
pub fn set_launch_at_login(app: AppHandle, enabled: bool) -> IpcResult<bool> {
    let launcher = app.autolaunch();
    let result = if enabled {
        launcher.enable()
    } else {
        launcher.disable()
    };
    result.map_err(|e| {
        IpcError::new(
            "autostart",
            format!("Launch at login could not be changed: {e}"),
        )
    })?;
    launcher
        .is_enabled()
        .map_err(|e| IpcError::new("autostart", e.to_string()))
}

#[tauri::command]
pub fn set_new_note_color(
    app: AppHandle,
    state: State<'_, AppState>,
    color: String,
) -> IpcResult<()> {
    state.with_db(|db| db.set_new_note_color(&color))?;
    emit_changed(&app, None, "other");
    Ok(())
}

/// The "Show / hide all notes" keyboard shortcut, as GNOME has it.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToggleShortcut {
    /// False on desktops without GNOME custom shortcuts.
    pub available: bool,
    /// Accelerator text, e.g. `<Control><Alt>n`; `None` when not set up.
    pub binding: Option<String>,
    /// Readable form, e.g. "Ctrl+Alt+N".
    pub label: Option<String>,
}

fn toggle_shortcut_view() -> ToggleShortcut {
    #[cfg(target_os = "linux")]
    {
        use crate::platform::gnome_shortcut as gnome;
        let current = gnome::current();
        ToggleShortcut {
            available: gnome::available(),
            binding: current.as_ref().map(|a| a.to_gsettings()),
            label: current.as_ref().map(|a| a.label()),
        }
    }
    #[cfg(not(target_os = "linux"))]
    {
        ToggleShortcut {
            available: false,
            binding: None,
            label: None,
        }
    }
}

#[tauri::command]
pub fn get_toggle_shortcut() -> ToggleShortcut {
    toggle_shortcut_view()
}

/// Add or change the GNOME custom shortcut that runs `desknotes --toggle-notes`.
/// The Settings window calls this only after the person confirmed it.
#[tauri::command]
pub fn set_toggle_shortcut(binding: String) -> IpcResult<ToggleShortcut> {
    #[cfg(target_os = "linux")]
    {
        use crate::platform::gnome_shortcut::{self as gnome, Accel};
        if !gnome::available() {
            return Err(IpcError::new(
                "shortcut",
                "This desktop has no GNOME keyboard shortcuts.",
            ));
        }
        let accel = Accel::parse(&binding)
            .ok_or_else(|| IpcError::new("validation", "This key combination is not supported."))?;
        if !accel.is_acceptable() {
            return Err(IpcError::new(
                "validation",
                "Use Ctrl, Alt or Super with the key.",
            ));
        }
        let taken = gnome::conflicts(&accel);
        if !taken.is_empty() {
            return Err(IpcError::new(
                "shortcut_taken",
                format!("{} is already used by {}.", accel.label(), taken.join(", ")),
            ));
        }
        let command = gnome::toggle_command().map_err(|e| IpcError::new("shortcut", e))?;
        gnome::install(&accel, &command).map_err(|e| IpcError::new("shortcut", e))?;
        Ok(toggle_shortcut_view())
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = binding;
        Err(IpcError::new(
            "shortcut",
            "Not available on this system yet.",
        ))
    }
}

/// Remove DeskNotes' GNOME custom shortcut (other shortcuts are kept).
#[tauri::command]
pub fn remove_toggle_shortcut() -> IpcResult<ToggleShortcut> {
    #[cfg(target_os = "linux")]
    if crate::platform::gnome_shortcut::available() {
        crate::platform::gnome_shortcut::remove().map_err(|e| IpcError::new("shortcut", e))?;
    }
    Ok(toggle_shortcut_view())
}

/// Show the folder that holds the notes database in the file manager.
#[tauri::command]
pub fn open_data_folder(app: AppHandle) -> IpcResult<()> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| IpcError::from(CoreError::Validation(e.to_string())))?;
    app.opener()
        .open_path(dir.display().to_string(), None::<&str>)
        .map_err(|e| IpcError::new("opener", e.to_string()))
}
