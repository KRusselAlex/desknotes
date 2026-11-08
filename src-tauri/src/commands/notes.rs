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
    if !unsaved.is_empty() {
        return Err(unsaved_error(unsaved.len()));
    }
    let state = app.state::<AppState>();
    let open: Vec<String> = windows::open_note_labels(app)
        .iter()
        .filter_map(|l| l.strip_prefix(windows::NOTE_PREFIX).map(str::to_owned))
        .collect();
    // A note marked done during the round has answered it but its window is still being
    // destroyed: it is not hidden (it is Completed, not hidden) and must not be remembered.
    let mut rows = Vec::with_capacity(open.len());
    for id in open {
        let note = state.with_db(|db| db.get_note(&id))?;
        rows.push((id, note.archived_at, note.deleted_at, note.completed_at));
    }
    let ids = without_window_refusal(rows);
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
        if window_refusal(note.archived_at, note.deleted_at, note.completed_at).is_some() {
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
    state.with_db(hidden_count)
}

/// Only notes "Show hidden notes" would really bring back: not those done, archived,
/// trashed or deleted since.
fn hidden_count(db: &desknotes_core::Database) -> desknotes_core::CoreResult<usize> {
    let rows: Vec<_> = db
        .hidden_by_hide_all()?
        .into_iter()
        .filter_map(|id| {
            let note = db.get_note(&id).ok()?;
            Some((id, note.archived_at, note.deleted_at, note.completed_at))
        })
        .collect();
    Ok(without_window_refusal(rows).len())
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
    // A private note kept open at the last lock (its text was not saved then)
    // is saved now: lock it, before the manager reloads its row.
    crate::privacy::release_kept_open(&app, &id);
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
        // A done note goes back to Completed, not onto the desktop.
        if opens_after_unarchive(note.archived_at, note.deleted_at, note.completed_at) {
            windows::open_note(&app, &note)?;
        }
    }
    emit_changed(&app, Some(&id), "other");
    Ok(())
}

/// Whether unarchiving a note puts its window on screen: only when the note is
/// now an active one (a done note goes back to Completed).
fn opens_after_unarchive(
    archived_at: Option<i64>,
    deleted_at: Option<i64>,
    completed_at: Option<i64>,
) -> bool {
    window_refusal(archived_at, deleted_at, completed_at).is_none()
}

/// Whether restoring a note from the trash puts its window on screen: it was
/// visible and is now an active note. A note that was done (or archived) before
/// it was trashed returns to Completed (or Archived) with no window.
fn opens_after_restore(
    visible: bool,
    archived_at: Option<i64>,
    deleted_at: Option<i64>,
    completed_at: Option<i64>,
) -> bool {
    visible && window_refusal(archived_at, deleted_at, completed_at).is_none()
}

/// How `set_note_completed` runs.
#[derive(Debug, PartialEq, Eq)]
enum CompleteRoute {
    /// Run it here.
    Direct,
    /// Ask the open note window to save and then call the command itself, so a
    /// pending edit is not lost when its window is destroyed.
    Delegate,
}

fn complete_route(done: bool, caller_is_note: bool, note_window_open: bool) -> CompleteRoute {
    if done && !caller_is_note && note_window_open {
        CompleteRoute::Delegate
    } else {
        CompleteRoute::Direct
    }
}

/// A note window that is about to be destroyed after saving answers the save-all round
/// for itself: "saved". No-op when no round is running or the window is not in it.
fn answer_round_for_closing_note(quit: &crate::quit::QuitCoordinator, label: &str) {
    quit.report(label, true);
}

/// Mark a note done (its window closes, as for archive) or reopen it (its window
/// opens at the saved place). Touches only the done date; the text, colour,
/// settings and reminder rule stay as they are. The note window calls it once
/// its "Marked done" strip ends, so nothing is written during the undo seconds.
#[tauri::command]
pub async fn set_note_completed(
    app: AppHandle,
    caller: WebviewWindow,
    state: State<'_, AppState>,
    id: String,
    done: bool,
) -> IpcResult<()> {
    let id = parse_note_id(&id)?;
    let label = windows::note_label(&id);
    let open = app.get_webview_window(&label).is_some();
    if complete_route(done, caller.label() == label, open) == CompleteRoute::Delegate
        && windows::delegate_to_note(&app, caller.label(), &id, "complete")
    {
        return Ok(());
    }
    let now = desknotes_core::now_ms();
    let changed = state.with_db(|db| db.set_completed(&id, done, now))?;
    if !done && !changed {
        // A stale Reopen click on a note that is not done: it may be hidden on purpose.
        return Ok(());
    }
    if done {
        // The window is destroyed below, so it can no longer answer a save-all round (quit,
        // export, restore, hide-all, lock). Its text was saved by the page before this call,
        // so answer for it now; outside a round this does nothing. Without it the round waits
        // out SAVE_TIMEOUT, and a private note would then be kept open past the lock.
        answer_round_for_closing_note(&state.quit, &label);
        // The Note settings window closes itself when its note is done (it
        // listens to `notes-changed`, as for archive).
        windows::close_note(&app, &id)?;
        windows::after_note_hidden(&app, &id);
    } else {
        let note = state.with_db(|db| db.get_note(&id))?;
        // A note that is also archived stays closed: it is listed as Archived.
        if window_refusal(note.archived_at, note.deleted_at, note.completed_at).is_none() {
            windows::open_note(&app, &note)?;
        }
    }
    // "other" wakes the reminder scheduler, so `next_wake` is recomputed.
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
    if opens_after_restore(
        note.window.visible,
        note.archived_at,
        note.deleted_at,
        note.completed_at,
    ) {
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
    show_note_window(&app, &state, &id)
}

/// Why a note must not get a window, or `None` when it may. Only an active note
/// (not trashed, archived or done) has a window: "Show hidden notes", a manager
/// row and a reminder click all go through this.
fn window_refusal(
    archived_at: Option<i64>,
    deleted_at: Option<i64>,
    completed_at: Option<i64>,
) -> Option<&'static str> {
    if deleted_at.is_some() {
        Some("restore the note before showing it")
    } else if archived_at.is_some() {
        Some("unarchive the note before showing it")
    } else if completed_at.is_some() {
        Some("reopen the note before showing it")
    } else {
        None
    }
}

/// Refused (`not_allowed`) for an archived, trashed or done note: it may have no window,
/// and so no Note settings window either.
pub(crate) fn ensure_may_have_window(note: &Note) -> IpcResult<()> {
    match window_refusal(note.archived_at, note.deleted_at, note.completed_at) {
        Some(message) => Err(IpcError::new("not_allowed", message)),
        None => Ok(()),
    }
}

/// The ids of the notes that may have a window: `(id, archived_at, deleted_at, completed_at)`
/// rows without a `window_refusal`.
fn without_window_refusal(
    rows: impl IntoIterator<Item = (String, Option<i64>, Option<i64>, Option<i64>)>,
) -> Vec<String> {
    rows.into_iter()
        .filter(|(_, archived, deleted, completed)| {
            window_refusal(*archived, *deleted, *completed).is_none()
        })
        .map(|(id, ..)| id)
        .collect()
}

/// Open (or focus) the note's window and remember it as visible. Refused for an
/// archived, trashed or done note. Also used by a click on a reminder notification.
pub fn show_note_window(app: &AppHandle, state: &AppState, id: &str) -> IpcResult<()> {
    let id = parse_note_id(id)?;
    let note = state.with_db(|db| db.get_note(&id))?;
    ensure_may_have_window(&note)?;
    state.with_db(|db| db.set_visible(&id, true))?;
    windows::open_note(app, &note)?;
    emit_changed(app, Some(&id), "other");
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

/// Take this note's pending checklist reset (automation rule 2), sent while its
/// window was open. The editor calls it when it loads and on each
/// `checklist-reset`, and unticks only when it returns true: once per reset.
#[tauri::command]
pub fn claim_checklist_reset(state: State<'_, AppState>, note_id: String) -> IpcResult<bool> {
    claim_reset(&state.pending_resets, &note_id)
}

fn claim_reset(pending: &crate::automation::PendingResets, note_id: &str) -> IpcResult<bool> {
    let id = parse_note_id(note_id)?;
    Ok(pending.claim(&id))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_note_done_during_a_round_answers_it_before_its_window_goes() {
        use std::collections::HashSet;
        use std::time::Duration;
        let quit = crate::quit::QuitCoordinator::default();
        let labels: HashSet<String> = ["note-a", "note-b"].iter().map(|s| s.to_string()).collect();
        quit.begin(labels);
        answer_round_for_closing_note(&quit, "note-a");
        quit.report("note-b", true);
        // Neither "not saved" nor "silent": a private note finishing in a lock round is not
        // kept open past the lock, and quit does not wait out the timeout.
        let outcome = quit.wait(Duration::from_millis(50));
        assert!(outcome.unsaved.is_empty());
        assert!(outcome.silent.is_empty());
    }

    #[test]
    fn answering_outside_a_round_does_nothing() {
        use std::time::Duration;
        let quit = crate::quit::QuitCoordinator::default();
        answer_round_for_closing_note(&quit, "note-a");
        assert_eq!(
            quit.wait(Duration::from_millis(10)),
            crate::quit::RoundOutcome::default()
        );
    }

    #[test]
    fn hide_all_and_the_hidden_count_skip_notes_that_may_not_have_a_window() {
        let rows = vec![
            ("active".to_string(), None, None, None),
            ("done".to_string(), None, None, Some(1)),
            ("archived".to_string(), Some(1), None, None),
            ("trashed".to_string(), None, Some(1), None),
            ("active-too".to_string(), None, None, None),
        ];
        assert_eq!(
            without_window_refusal(rows),
            vec!["active".to_string(), "active-too".to_string()]
        );
        assert!(without_window_refusal(Vec::new()).is_empty());
    }

    #[test]
    fn only_a_note_that_may_have_a_window_gets_one_or_its_settings() {
        let db = desknotes_core::Database::open_in_memory().unwrap();
        let id = db.create_note(None).unwrap().id;
        assert!(ensure_may_have_window(&db.get_note(&id).unwrap()).is_ok());
        db.set_completed(&id, true, 1).unwrap();
        let err = ensure_may_have_window(&db.get_note(&id).unwrap()).unwrap_err();
        assert_eq!(err.code, "not_allowed");
        assert_eq!(err.message, "reopen the note before showing it");
    }

    #[test]
    fn the_hidden_count_is_what_show_hidden_notes_would_bring_back() {
        let db = desknotes_core::Database::open_in_memory().unwrap();
        let new = || db.create_note(None).unwrap().id;
        let (active, done, archived, trashed, purged) = (new(), new(), new(), new(), new());
        db.set_hidden_by_hide_all(&[
            active.clone(),
            done.clone(),
            archived.clone(),
            trashed.clone(),
            purged.clone(),
        ])
        .unwrap();
        assert_eq!(hidden_count(&db).unwrap(), 5);
        // Since the hide-all: done, archived, trashed, and one gone for good.
        db.set_completed(&done, true, 1).unwrap();
        db.set_archived(&archived, true).unwrap();
        db.trash_note(&trashed).unwrap();
        db.trash_note(&purged).unwrap();
        db.purge_note(&purged).unwrap();
        assert_eq!(hidden_count(&db).unwrap(), 1, "only {active}");
    }

    #[test]
    fn an_active_note_may_get_a_window() {
        assert!(window_refusal(None, None, None).is_none());
    }

    #[test]
    fn archived_trashed_and_done_notes_never_get_a_window() {
        assert!(window_refusal(Some(1), None, None).is_some());
        assert!(window_refusal(None, Some(1), None).is_some());
        assert!(window_refusal(None, None, Some(1)).is_some());
        assert!(window_refusal(Some(1), Some(2), Some(3)).is_some());
    }

    #[test]
    fn a_done_note_is_told_to_reopen_first() {
        let message = window_refusal(None, None, Some(1)).unwrap();
        assert!(message.contains("reopen"), "{message}");
    }

    #[test]
    fn unarchiving_a_done_note_does_not_open_it() {
        // Done, then archived, then unarchived: it goes back to Completed.
        assert!(!opens_after_unarchive(None, None, Some(1)));
        assert!(opens_after_unarchive(None, None, None));
        assert!(!opens_after_unarchive(None, Some(1), None));
    }

    #[test]
    fn restoring_a_done_note_from_the_trash_does_not_open_it() {
        // Done, then trashed, then restored: it goes back to Completed, even
        // though its window was visible when it was marked done.
        assert!(!opens_after_restore(true, None, None, Some(1)));
        assert!(opens_after_restore(true, None, None, None));
        assert!(!opens_after_restore(false, None, None, None));
        assert!(!opens_after_restore(true, Some(1), None, None));
    }

    #[test]
    fn done_is_handed_to_an_open_note_window_not_called_from_it() {
        assert_eq!(complete_route(true, false, true), CompleteRoute::Delegate);
        assert_eq!(complete_route(true, true, true), CompleteRoute::Direct);
        assert_eq!(complete_route(true, false, false), CompleteRoute::Direct);
        // Reopening never waits for a window: there is none.
        assert_eq!(complete_route(false, false, true), CompleteRoute::Direct);
    }

    #[test]
    fn claiming_a_checklist_reset_needs_a_note_id_and_works_once() {
        let pending = crate::automation::PendingResets::default();
        let id = "0b9d6f6e-3f0a-4b8e-9a51-2a4c1d7e8f90";
        pending.insert(id);
        assert_eq!(
            claim_reset(&pending, "../x").unwrap_err().code,
            "validation"
        );
        assert!(pending.claim(id), "a refused id claims nothing");
        pending.insert(id);
        // The id is normalised as everywhere else.
        assert!(claim_reset(&pending, &id.to_uppercase()).unwrap());
        assert!(!claim_reset(&pending, id).unwrap());
    }
}
