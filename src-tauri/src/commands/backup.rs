use std::fs;
use std::path::{Path, PathBuf};

use desknotes_core::backup::{MAX_BACKUP_BYTES, parse_backup};
use desknotes_core::db::LAST_BACKUP_AT;
use desknotes_core::now_ms;
use serde::Serialize;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::DialogExt as _;

use super::app::SAVE_TIMEOUT;
use super::settings::emit_automations;
use crate::error::{IpcError, IpcResult, unsaved_error};
use crate::state::{AppState, PendingRestore};
use crate::windows::{self, emit_changed};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportResult {
    pub path: String,
    pub count: usize,
    /// Notes left out because their stored content is unreadable.
    pub skipped: usize,
    /// Notes exported without their reminder, because its stored row is unreadable.
    pub damaged_reminders: usize,
    pub exported_at: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestorePreview {
    pub file_name: String,
    pub backup_count: usize,
    pub current_count: i64,
    pub exported_at: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreResult {
    pub restored: usize,
    /// Where the copy of the previous notes was saved.
    pub safety_copy: String,
}

/// "desknotes-2026-11-01.json" for today's date (UTC).
fn default_file_name(ms: i64) -> String {
    // Civil date from days since 1970-01-01 (Howard Hinnant's algorithm).
    let z = ms.div_euclid(86_400_000) + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!("desknotes-{year:04}-{month:02}-{day:02}.json")
}

/// Write `data` next to `path` first, then move it into place, so a crash can
/// never leave a half-written backup under the chosen name.
fn write_atomically(path: &Path, data: &[u8]) -> std::io::Result<()> {
    let tmp = path.with_extension("json.partial");
    fs::write(&tmp, data)?;
    fs::rename(&tmp, path)
}

/// Save every note (all tabs) to a JSON file the user chooses.
#[tauri::command]
pub async fn export_backup(
    app: AppHandle,
    state: State<'_, AppState>,
) -> IpcResult<Option<ExportResult>> {
    // Ask for the PIN before the file dialog, not after (design D12, §4.4).
    state.with_db(|db| db.refuse_if_any_private_locked())?;
    let unsaved = windows::save_all_open_notes(&app, SAVE_TIMEOUT);
    if !unsaved.is_empty() {
        return Err(unsaved_error(unsaved.len()));
    }
    let Some(chosen) = app
        .dialog()
        .file()
        .set_title("Export backup")
        .add_filter("DeskNotes backup", &["json"])
        .set_file_name(default_file_name(now_ms()))
        .blocking_save_file()
    else {
        return Ok(None); // cancelled
    };
    let path: PathBuf = chosen
        .into_path()
        .map_err(|e| IpcError::new("io", e.to_string()))?;
    let version = app.package_info().version.to_string();
    let export = state.with_db(|db| db.export_backup(&version))?;
    let json = serde_json::to_vec_pretty(&export.backup)
        .map_err(|e| IpcError::new("io", e.to_string()))?;
    write_atomically(&path, &json)
        .map_err(|e| IpcError::new("io", format!("The backup could not be written: {e}")))?;
    let at = export.backup.exported_at;
    state.with_db(|db| db.set_setting(LAST_BACKUP_AT, &at.to_string()))?;
    Ok(Some(ExportResult {
        path: path.display().to_string(),
        count: export.backup.notes.len(),
        skipped: export.skipped.len(),
        damaged_reminders: export.damaged_reminders.len(),
        exported_at: at,
    }))
}

/// Let the user pick a backup file, validate it completely and keep it for
/// confirmation. Nothing is changed yet.
#[tauri::command]
pub async fn choose_backup(
    app: AppHandle,
    state: State<'_, AppState>,
) -> IpcResult<Option<RestorePreview>> {
    // Ask for the PIN before the file dialog, not after (design D12).
    state.with_db(|db| db.refuse_if_any_private_locked())?;
    let Some(chosen) = app
        .dialog()
        .file()
        .set_title("Restore from backup")
        .add_filter("DeskNotes backup", &["json"])
        .blocking_pick_file()
    else {
        return Ok(None);
    };
    let path = chosen
        .into_path()
        .map_err(|e| IpcError::new("io", e.to_string()))?;
    let size = fs::metadata(&path)
        .map_err(|e| IpcError::new("io", e.to_string()))?
        .len();
    if size > MAX_BACKUP_BYTES as u64 {
        return Err(IpcError::new(
            "validation",
            "This backup file is too large.",
        ));
    }
    let raw = fs::read_to_string(&path)
        .map_err(|e| IpcError::new("io", format!("The file could not be read: {e}")))?;
    let backup = parse_backup(&raw)?;
    let file_name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let preview = RestorePreview {
        file_name,
        backup_count: backup.notes.len(),
        current_count: state.with_db(|db| db.count_all_notes())?,
        exported_at: backup.exported_at,
    };
    *state
        .pending_restore
        .lock()
        .map_err(|_| IpcError::new("internal", "lock poisoned"))? = Some(PendingRestore { backup });
    Ok(Some(preview))
}

#[tauri::command]
pub fn cancel_restore(state: State<'_, AppState>) {
    if let Ok(mut pending) = state.pending_restore.lock() {
        *pending = None;
    }
}

/// Replace every note with the confirmed backup. Open notes are saved first
/// (the restore is refused if one cannot save), a copy of the current
/// database is written to backups/, then the notes are replaced in one
/// transaction and the visible ones reopen.
#[tauri::command]
pub async fn restore_backup(
    app: AppHandle,
    state: State<'_, AppState>,
) -> IpcResult<RestoreResult> {
    // The core refuses too; checking first keeps the open notes untouched.
    state.with_db(|db| db.refuse_if_any_private_locked())?;
    let unsaved = windows::save_all_open_notes(&app, SAVE_TIMEOUT);
    if !unsaved.is_empty() {
        return Err(unsaved_error(unsaved.len()));
    }
    let pending = state
        .pending_restore
        .lock()
        .map_err(|_| IpcError::new("internal", "lock poisoned"))?
        .take()
        .ok_or_else(|| IpcError::new("not_allowed", "Choose a backup file first."))?;
    // Close note windows so none of them can save old text over restored notes.
    for label in windows::open_note_labels(&app) {
        if let Some(id) = label.strip_prefix(windows::NOTE_PREFIX) {
            windows::close_note(&app, id)?;
        }
    }
    let safety_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| IpcError::new("io", e.to_string()))?
        .join("backups");
    // Inside the same call: no reminder pass can read the new database as the old one.
    let copy = state.with_db(|db| {
        let copy = db.restore_backup(&pending.backup, &safety_dir)?;
        crate::reminders::database_replaced(&app);
        Ok(copy)
    })?;
    // A restore turns "Empty old trash" off: an open Settings window must hear of it, or
    // its next save would carry the old rules.
    match state.with_db(|db| db.automations()) {
        Ok(rules) => emit_automations(&app, &rules),
        Err(e) => eprintln!(
            "DeskNotes: could not read the automations after a restore: {}",
            e.message
        ),
    }
    let (notes, _) = state.with_db(|db| db.notes_to_show())?;
    for note in &notes {
        windows::open_note(&app, note)?;
    }
    emit_changed(&app, None, "other");
    Ok(RestoreResult {
        restored: pending.backup.notes.len(),
        safety_copy: copy.display().to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::default_file_name;

    #[test]
    fn file_name_uses_the_utc_date() {
        assert_eq!(default_file_name(0), "desknotes-1970-01-01.json");
        assert_eq!(
            default_file_name(1_793_520_000_000),
            "desknotes-2026-11-01.json"
        );
        assert_eq!(
            default_file_name(951_782_400_000),
            "desknotes-2000-02-29.json"
        );
    }
}
