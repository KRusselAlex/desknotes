use desknotes_core::validation::parse_note_id;
use desknotes_core::{Note, NoteFilter, NoteSummary, SaveResult};
use tauri::{AppHandle, State};

use crate::error::{IpcError, IpcResult};
use crate::state::AppState;
use crate::windows::{self, emit_changed};

#[tauri::command]
pub fn list_notes(
    state: State<'_, AppState>,
    filter: NoteFilter,
    query: Option<String>,
) -> IpcResult<Vec<NoteSummary>> {
    state.with_db(|db| db.list_notes(filter, query.as_deref()))
}

#[tauri::command]
pub fn get_note(state: State<'_, AppState>, id: String) -> IpcResult<Note> {
    let id = parse_note_id(&id)?;
    state.with_db(|db| db.get_note(&id))
}

// Commands that create windows are async: creating a window from a
// synchronous command deadlocks on Windows (Tauri documentation).
#[tauri::command]
pub async fn create_note(app: AppHandle, state: State<'_, AppState>) -> IpcResult<Note> {
    let note = state.with_db(|db| db.create_note(None))?;
    windows::open_note(&app, &note)?;
    emit_changed(&app, Some(&note.id), "other");
    Ok(note)
}

#[tauri::command]
pub fn save_note_content(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    content: String,
) -> IpcResult<SaveResult> {
    let id = parse_note_id(&id)?;
    let result = state.with_db(|db| db.save_content(&id, &content))?;
    emit_changed(&app, Some(&id), "content");
    Ok(result)
}

#[tauri::command]
pub fn set_note_color(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    color: String,
) -> IpcResult<()> {
    let id = parse_note_id(&id)?;
    state.with_db(|db| db.set_color(&id, &color))?;
    emit_changed(&app, Some(&id), "other");
    Ok(())
}

#[tauri::command]
pub async fn duplicate_note(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> IpcResult<Note> {
    let id = parse_note_id(&id)?;
    let copy = state.with_db(|db| db.duplicate_note(&id))?;
    windows::open_note(&app, &copy)?;
    emit_changed(&app, Some(&copy.id), "other");
    Ok(copy)
}

#[tauri::command]
pub async fn set_archived(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    archived: bool,
) -> IpcResult<()> {
    let id = parse_note_id(&id)?;
    if archived {
        windows::close_note(&app, &id)?;
    }
    state.with_db(|db| db.set_archived(&id, archived))?;
    if archived {
        windows::after_note_hidden(&app, &id);
    } else {
        let note = state.with_db(|db| db.get_note(&id))?;
        windows::open_note(&app, &note)?;
    }
    emit_changed(&app, Some(&id), "other");
    Ok(())
}

#[tauri::command]
pub async fn trash_note(app: AppHandle, state: State<'_, AppState>, id: String) -> IpcResult<()> {
    let id = parse_note_id(&id)?;
    windows::close_note(&app, &id)?;
    state.with_db(|db| db.trash_note(&id))?;
    windows::after_note_hidden(&app, &id);
    emit_changed(&app, Some(&id), "other");
    Ok(())
}

#[tauri::command]
pub async fn restore_note(app: AppHandle, state: State<'_, AppState>, id: String) -> IpcResult<()> {
    let id = parse_note_id(&id)?;
    state.with_db(|db| db.restore_note(&id))?;
    let note = state.with_db(|db| db.get_note(&id))?;
    if note.window.visible {
        windows::open_note(&app, &note)?;
    }
    emit_changed(&app, Some(&id), "other");
    Ok(())
}

/// Permanent deletion. The core refuses unless the note is already in the trash.
#[tauri::command]
pub fn purge_note(app: AppHandle, state: State<'_, AppState>, id: String) -> IpcResult<()> {
    let id = parse_note_id(&id)?;
    state.with_db(|db| db.purge_note(&id))?;
    emit_changed(&app, None, "other");
    Ok(())
}

#[tauri::command]
pub async fn show_note(app: AppHandle, state: State<'_, AppState>, id: String) -> IpcResult<()> {
    let id = parse_note_id(&id)?;
    let note = state.with_db(|db| db.get_note(&id))?;
    if note.archived_at.is_some() || note.deleted_at.is_some() {
        return Err(IpcError::new(
            "not_allowed",
            "restore or unarchive the note before showing it",
        ));
    }
    state.with_db(|db| db.set_visible(&id, true))?;
    windows::open_note(&app, &note)?;
    emit_changed(&app, Some(&id), "other");
    Ok(())
}

#[tauri::command]
pub async fn hide_note(app: AppHandle, state: State<'_, AppState>, id: String) -> IpcResult<()> {
    let id = parse_note_id(&id)?;
    state.with_db(|db| db.set_visible(&id, false))?;
    windows::close_note(&app, &id)?;
    windows::after_note_hidden(&app, &id);
    emit_changed(&app, Some(&id), "other");
    Ok(())
}

/// Make a note read-only (or editable again). Enforced in the core: saves are
/// refused while locked, whatever the webview sends.
#[tauri::command]
pub fn set_edit_locked(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    locked: bool,
) -> IpcResult<()> {
    let id = parse_note_id(&id)?;
    state.with_db(|db| db.set_edit_locked(&id, locked))?;
    emit_changed(&app, Some(&id), "other");
    Ok(())
}
