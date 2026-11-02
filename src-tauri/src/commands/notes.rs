use desknotes_core::validation::parse_note_id;
use desknotes_core::{Note, NoteCounts, NoteFilter, NoteSummary, SaveResult};
use tauri::{AppHandle, Manager, State, WebviewWindow};

use super::app::SAVE_TIMEOUT;
use crate::error::{IpcError, IpcResult, unsaved_error};
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
pub fn note_counts(state: State<'_, AppState>) -> IpcResult<NoteCounts> {
    state.with_db(|db| db.count_notes())
}

#[tauri::command]
pub fn get_note(state: State<'_, AppState>, id: String) -> IpcResult<Note> {
    let id = parse_note_id(&id)?;
    state.with_db(|db| db.get_note(&id))
}

// Commands that create windows are async: creating a window from a
// synchronous command deadlocks on Windows (Tauri documentation).
#[tauri::command]
pub async fn create_note(app: AppHandle) -> IpcResult<Note> {
    new_note(&app)
}

/// Create a note in the preferred colour and open its window.
pub fn new_note(app: &AppHandle) -> IpcResult<Note> {
    let state = app.state::<AppState>();
    let note = state.with_db(|db| {
        let color = db.new_note_color()?;
        db.create_note(Some(&color))
    })?;
    windows::open_note(app, &note)?;
    emit_changed(app, Some(&note.id), "other");
    Ok(note)
}

/// Save every open note, then hide them all and remember which ones, so
/// "Show hidden notes" brings back exactly those. Blocking: never call it on
/// the main thread.
pub fn hide_all(app: &AppHandle) -> IpcResult<usize> {
    let unsaved = windows::save_all_open_notes(app, SAVE_TIMEOUT);
    if unsaved > 0 {
        return Err(unsaved_error(unsaved));
    }
    let state = app.state::<AppState>();
    let ids: Vec<String> = windows::open_note_labels(app)
        .iter()
        .filter_map(|l| l.strip_prefix(windows::NOTE_PREFIX).map(str::to_owned))
        .collect();
    for id in &ids {
        state.with_db(|db| db.set_visible(id, false))?;
        windows::close_note(app, id)?;
    }
    // Hiding again keeps the notes hidden earlier in the list too.
    let mut remembered = state.with_db(|db| db.hidden_by_hide_all())?;
    for id in &ids {
        if !remembered.contains(id) {
            remembered.push(id.clone());
        }
    }
    state.with_db(|db| db.set_hidden_by_hide_all(&remembered))?;
    // Without a tray icon the manager is the only way back.
    if !state.tray_available() {
        windows::show_manager(app)?;
    }
    emit_changed(app, None, "other");
    Ok(ids.len())
}

/// Show again the notes hidden by "Hide all notes" (those still active).
pub fn show_hidden(app: &AppHandle) -> IpcResult<usize> {
    let state = app.state::<AppState>();
    let ids = state.with_db(|db| db.hidden_by_hide_all())?;
    let mut shown = 0;
    for id in &ids {
        let Ok(note) = state.with_db(|db| db.get_note(id)) else {
            continue;
        };
        if note.archived_at.is_some() || note.deleted_at.is_some() {
            continue;
        }
        state.with_db(|db| db.set_visible(id, true))?;
        windows::open_note(app, &note)?;
        shown += 1;
    }
    state.with_db(|db| db.set_hidden_by_hide_all(&[]))?;
    emit_changed(app, None, "other");
    Ok(shown)
}

/// The "Show / hide all notes" shortcut: hide every open note, or bring back the
/// hidden ones. With nothing to bring back the manager opens, so the key always
/// shows something.
pub fn toggle_notes(app: &AppHandle) -> IpcResult<()> {
    if windows::open_note_labels(app).is_empty() {
        if show_hidden(app)? == 0 {
            windows::show_manager(app)?;
        }
    } else {
        hide_all(app)?;
    }
    Ok(())
}

#[tauri::command]
pub async fn hide_all_notes(app: AppHandle) -> IpcResult<usize> {
    hide_all(&app)
}

#[tauri::command]
pub async fn show_hidden_notes(app: AppHandle) -> IpcResult<usize> {
    show_hidden(&app)
}

/// How many notes "Show hidden notes" would bring back.
#[tauri::command]
pub fn hidden_note_count(state: State<'_, AppState>) -> IpcResult<usize> {
    Ok(state.with_db(|db| db.hidden_by_hide_all())?.len())
}

#[tauri::command]
pub fn save_note_content(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    content: String,
) -> IpcResult<SaveResult> {
    let id = parse_note_id(&id)?;
    let result = state
        .with_db(|db| db.save_content(&id, &content))
        // The reason only, never the text: a refused save must be diagnosable.
        .inspect_err(|e| {
            eprintln!(
                "DeskNotes: a note was not saved ({}): {}",
                e.code, e.message
            )
        })?;
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
    caller: WebviewWindow,
    state: State<'_, AppState>,
    id: String,
    archived: bool,
) -> IpcResult<()> {
    let id = parse_note_id(&id)?;
    if archived {
        if windows::delegate_to_note(&app, caller.label(), &id, "archive") {
            return Ok(());
        }
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
pub async fn trash_note(
    app: AppHandle,
    caller: WebviewWindow,
    state: State<'_, AppState>,
    id: String,
) -> IpcResult<()> {
    let id = parse_note_id(&id)?;
    if windows::delegate_to_note(&app, caller.label(), &id, "trash") {
        return Ok(());
    }
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
    // A trashed note should have no window; close one if a bug left it open.
    windows::close_note(&app, &id)?;
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
pub async fn hide_note(
    app: AppHandle,
    caller: WebviewWindow,
    state: State<'_, AppState>,
    id: String,
) -> IpcResult<()> {
    let id = parse_note_id(&id)?;
    if windows::delegate_to_note(&app, caller.label(), &id, "hide") {
        return Ok(());
    }
    state.with_db(|db| db.set_visible(&id, false))?;
    windows::close_note(&app, &id)?;
    windows::after_note_hidden(&app, &id);
    emit_changed(&app, Some(&id), "other");
    Ok(())
}

/// Keep a note above other windows (or not).
#[tauri::command]
pub fn set_always_on_top(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    on: bool,
) -> IpcResult<()> {
    let id = parse_note_id(&id)?;
    state.with_db(|db| db.set_always_on_top(&id, on))?;
    if let Some(window) = app.get_webview_window(&windows::note_label(&id)) {
        window.set_always_on_top(on)?;
    }
    emit_changed(&app, Some(&id), "other");
    Ok(())
}

/// Roll a note up to its header strip, or expand it to its saved size.
#[tauri::command]
pub fn set_collapsed(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    collapsed: bool,
) -> IpcResult<()> {
    let id = parse_note_id(&id)?;
    // Write any pending move/resize first so the saved size is the latest one.
    state.geometry.flush();
    let note = state.with_db(|db| {
        db.set_collapsed(&id, collapsed)?;
        db.get_note(&id)
    })?;
    if let Some(window) = app.get_webview_window(&windows::note_label(&id)) {
        let min = state.with_db(|db| db.min_note_size())?;
        windows::apply_collapsed(
            &window,
            collapsed,
            note.window.width,
            note.window.height,
            min,
        )?;
    }
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
