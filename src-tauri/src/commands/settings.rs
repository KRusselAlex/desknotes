use desknotes_core::{AppAppearance, CoreError, NoteSize};
use serde::Serialize;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_autostart::ManagerExt as _;
use tauri_plugin_opener::OpenerExt as _;

use crate::error::{IpcError, IpcResult};
use crate::state::AppState;
use crate::windows::{self, emit_app_appearance_changed, emit_changed};

/// Everything the Settings window shows.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsView {
    pub launch_at_login: bool,
    pub new_note_color: String,
    pub min_note_size: NoteSize,
    /// App-wide look of every note window (Settings → Appearance).
    pub app_appearance: AppAppearance,
    pub version: String,
    /// Readable OS name, e.g. "Ubuntu 24.04.1 LTS" (About window).
    pub os_name: String,
    pub data_dir: String,
    /// Time of the last successful export (Unix ms), if any.
    pub last_backup_at: Option<i64>,
}

/// Opens Settings, at `section` when given ("general", "privacy",
/// "privacy-new-pin", "backup" or "about"; anything else is refused).
#[tauri::command]
pub async fn open_settings(app: AppHandle, section: Option<String>) -> IpcResult<()> {
    let section = parse_section(section.as_deref())?;
    Ok(windows::open_settings(&app, section)?)
}

fn parse_section(name: Option<&str>) -> IpcResult<Option<&'static str>> {
    match name {
        None => Ok(None),
        Some(name) => windows::settings_section(name)
            .map(Some)
            .ok_or_else(|| IpcError::new("validation", "There is no such Settings section.")),
    }
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
        min_note_size: state.with_db(|db| db.min_note_size())?,
        app_appearance: state.with_db(|db| db.app_appearance())?,
        version: app.package_info().version.to_string(),
        os_name: crate::platform::os_name(),
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
            // A key changed by hand in GNOME Settings that DeskNotes cannot read is
            // shown as GNOME stores it, and can still be removed.
            label: current.as_ref().map(|c| {
                c.accel
                    .as_ref()
                    .map_or_else(|| c.binding.clone(), |a| a.label())
            }),
            binding: current.map(|c| c.accel.map_or(c.binding, |a| a.to_gsettings())),
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

/// Some changes are made only from the Settings window, where the person
/// confirms them: the desktop's keyboard settings and the privacy lock. Note
/// windows and the manager cannot make them.
pub(crate) fn only_from_settings(window: &tauri::WebviewWindow, what: &str) -> IpcResult<()> {
    only_from_settings_label(window.label(), what)
}

/// [`only_from_settings`] for a window label (testable without a window).
pub(crate) fn only_from_settings_label(label: &str, what: &str) -> IpcResult<()> {
    if label == windows::SETTINGS {
        Ok(())
    } else {
        Err(IpcError::new(
            "not_allowed",
            format!("{what} can only be changed in Settings."),
        ))
    }
}

const SHORTCUT: &str = "The keyboard shortcut";

#[tauri::command]
pub fn get_toggle_shortcut() -> ToggleShortcut {
    toggle_shortcut_view()
}

/// Add or change the GNOME custom shortcut that runs `desknotes --toggle-notes`.
/// The Settings window calls this only after the person confirmed it.
#[tauri::command]
pub fn set_toggle_shortcut(
    window: tauri::WebviewWindow,
    binding: String,
) -> IpcResult<ToggleShortcut> {
    only_from_settings(&window, SHORTCUT)?;
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
pub fn remove_toggle_shortcut(window: tauri::WebviewWindow) -> IpcResult<ToggleShortcut> {
    only_from_settings(&window, SHORTCUT)?;
    #[cfg(target_os = "linux")]
    if crate::platform::gnome_shortcut::available() {
        crate::platform::gnome_shortcut::remove().map_err(|e| IpcError::new("shortcut", e))?;
    }
    Ok(toggle_shortcut_view())
}

/// Change the smallest size a note window may take, for open notes too.
/// Returns the size that was saved.
#[tauri::command]
pub fn set_min_note_size(
    app: AppHandle,
    state: State<'_, AppState>,
    width: u32,
    height: u32,
) -> IpcResult<NoteSize> {
    let size = state.with_db(|db| db.set_min_note_size(width, height))?;
    windows::apply_min_note_size(&app, size);
    Ok(size)
}

/// The app-wide note appearance. Note windows read it before their first paint.
#[tauri::command]
pub fn get_app_appearance(state: State<'_, AppState>) -> IpcResult<AppAppearance> {
    state.with_db(|db| db.app_appearance())
}

/// Save the app-wide note appearance, then tell every window the normalised
/// value. A refused value stores nothing and sends nothing.
#[tauri::command]
pub fn set_app_appearance(
    app: AppHandle,
    state: State<'_, AppState>,
    appearance: AppAppearance,
) -> IpcResult<AppAppearance> {
    let saved = state.with_db(|db| db.set_app_appearance(appearance))?;
    emit_app_appearance_changed(&app, &saved);
    Ok(saved)
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

const REPO: &str = "https://github.com/KRusselAlex/desknotes";

/// The address behind a fixed About link id. The webview sends an id, never a
/// URL; anything else is refused.
fn link_url(id: &str, version: &str) -> Option<String> {
    Some(match id {
        "source" => REPO.to_owned(),
        "issues" => format!("{REPO}/issues"),
        "more_tools" => "https://github.com/KRusselAlex".to_owned(),
        "notices" => format!("{REPO}/blob/v{version}/THIRD_PARTY_NOTICES.md"),
        "license" => format!("{REPO}/blob/v{version}/LICENSE"),
        _ => return None,
    })
}

/// Open one of the About window's fixed links in the system browser. Only
/// called when the person clicks it.
#[tauri::command]
pub fn open_external_link(app: AppHandle, id: String) -> IpcResult<()> {
    let version = app.package_info().version.to_string();
    let url = link_url(&id, &version)
        .ok_or_else(|| IpcError::new("validation", "There is no such link."))?;
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|e| IpcError::new("opener", e.to_string()))
}

#[cfg(test)]
mod link_tests {
    use super::link_url;

    #[test]
    fn link_url_knows_only_fixed_ids() {
        let r = "https://github.com/KRusselAlex/desknotes";
        assert_eq!(link_url("source", "1.2.3").as_deref(), Some(r));
        assert_eq!(
            link_url("issues", "1.2.3").as_deref(),
            Some("https://github.com/KRusselAlex/desknotes/issues")
        );
        assert_eq!(
            link_url("more_tools", "1.2.3").as_deref(),
            Some("https://github.com/KRusselAlex")
        );
        assert_eq!(
            link_url("notices", "1.2.3").as_deref(),
            Some("https://github.com/KRusselAlex/desknotes/blob/v1.2.3/THIRD_PARTY_NOTICES.md")
        );
        assert_eq!(
            link_url("license", "1.2.3").as_deref(),
            Some("https://github.com/KRusselAlex/desknotes/blob/v1.2.3/LICENSE")
        );
        for bad in ["", "https://x", "SOURCE", "../", "source ", "notices/.."] {
            assert_eq!(link_url(bad, "1.2.3"), None, "{bad:?}");
        }
    }
}

#[cfg(test)]
mod section_tests {
    use super::parse_section;

    #[test]
    fn open_settings_accepts_known_sections_only() {
        assert_eq!(parse_section(None).unwrap(), None);
        assert_eq!(parse_section(Some("privacy")).unwrap(), Some("privacy"));
        assert_eq!(
            parse_section(Some("privacy-new-pin")).unwrap(),
            Some("privacy-new-pin")
        );
        let err = parse_section(Some("index.html")).unwrap_err();
        assert_eq!(err.code, "validation");
    }
}

#[cfg(test)]
mod appearance_tests {
    use crate::error::IpcError;
    use desknotes_core::{AppAppearance, Database, Layout};

    /// What `set_app_appearance` does with the database, as the webview sees it.
    fn save(db: &Database, a: AppAppearance) -> Result<AppAppearance, IpcError> {
        Ok(db.set_app_appearance(a)?)
    }

    #[test]
    fn a_refused_appearance_is_a_validation_error_and_stores_nothing() {
        let db = Database::open_in_memory().unwrap();
        let bad_font = AppAppearance {
            high_contrast: true,
            layout: Layout::Compact,
            default_font: Some("Evil;Font".into()),
            default_size: 15,
        };
        assert_eq!(save(&db, bad_font).unwrap_err().code, "validation");
        let too_big = AppAppearance {
            default_size: 99,
            ..AppAppearance::default()
        };
        assert_eq!(save(&db, too_big).unwrap_err().code, "validation");
        assert_eq!(db.app_appearance().unwrap(), AppAppearance::default());
    }

    #[test]
    fn a_saved_appearance_is_returned_normalised_and_serialises_camel_case() {
        let db = Database::open_in_memory().unwrap();
        let saved = save(
            &db,
            AppAppearance {
                high_contrast: true,
                layout: Layout::Compact,
                default_font: Some("  Ubuntu  ".into()),
                default_size: 18,
            },
        )
        .unwrap();
        assert_eq!(saved.default_font.as_deref(), Some("Ubuntu"));
        assert_eq!(db.app_appearance().unwrap(), saved);
        assert_eq!(
            serde_json::to_value(&saved).unwrap(),
            serde_json::json!({
                "highContrast": true,
                "layout": "compact",
                "defaultFont": "Ubuntu",
                "defaultSize": 18
            })
        );
    }
}
