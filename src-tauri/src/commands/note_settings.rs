//! Commands behind the per-note settings window: text and background styling,
//! the note's size, and the list of installed fonts.

use std::time::{Duration, Instant};

use desknotes_core::geometry::{Rect, keep_on_screen};
use desknotes_core::validation::parse_note_id;
use desknotes_core::{Appearance, COLLAPSED_HEIGHT, NoteSize};
use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, State, WebviewWindow};

use crate::error::{IpcError, IpcResult};
use crate::platform::{fonts, window_positioning_supported};
use crate::state::AppState;
use crate::windows::{self, emit_changed};

/// How a size change reaches a note.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SizePlan {
    /// Open and expanded: resize the window; its resize event saves the size.
    Live,
    /// Open and collapsed: save the (expanded) size, and give the strip the new
    /// width now. Otherwise the strip's next move or resize would write its old
    /// width over the new one.
    SavedAndStrip,
    /// Closed: save the size; it is used when the note opens.
    SavedOnly,
}

fn size_plan(open: bool, collapsed: bool) -> SizePlan {
    match (open, collapsed) {
        (true, false) => SizePlan::Live,
        (true, true) => SizePlan::SavedAndStrip,
        (false, _) => SizePlan::SavedOnly,
    }
}

/// Whether an open note window must be recreated: it was created with a
/// different transparency than its opacity now needs. `None`: no window.
fn needs_reopen(window_transparent: Option<bool>, wanted: bool) -> bool {
    window_transparent.is_some_and(|now| now != wanted)
}

/// Style a note. Saved by the core (which validates every field), then every
/// window is told. A note window is created with transparency only when its
/// opacity is below 100 %, so when the open window's transparency no longer
/// matches, it is asked to save and reopen itself (`reopen`, handled by the
/// note). Compared with the window itself, not the opacity saved before: a
/// reopen that did not happen is caught up by the next change.
#[tauri::command]
pub fn set_note_appearance(
    app: AppHandle,
    caller: WebviewWindow,
    state: State<'_, AppState>,
    id: String,
    appearance: Appearance,
) -> IpcResult<()> {
    let id = parse_note_id(&id)?;
    state.with_db(|db| db.set_appearance(&id, &appearance))?;
    let wanted = windows::needs_transparency(&state.with_db(|db| db.get_note(&id))?.appearance);
    emit_changed(&app, Some(&id), "other");
    if needs_reopen(windows::window_transparency(&app, &id), wanted) {
        windows::delegate_to_note(&app, caller.label(), &id, "reopen");
    }
    Ok(())
}

/// Resize a note. The size is limited to the minimum note size and the work
/// area of the screen the note is on, and rounded to whole pixels; the size
/// applied is returned. An open, expanded note is resized live (the resize
/// event saves it). A collapsed open note has its saved size changed (used when
/// it is expanded) and its strip given the new width now; a closed one only gets
/// its saved size changed (used when it opens). A resized open window that would
/// run off its screen is moved back (where positioning is supported).
#[tauri::command]
pub fn set_note_size(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    width: f64,
    height: f64,
) -> IpcResult<NoteSize> {
    let id = parse_note_id(&id)?;
    // Pending move/resize writes first, so the note's saved place is current.
    state.geometry.flush();
    let note = state.with_db(|db| db.get_note(&id))?;
    let min = windows::min_note_size(&app);
    let here = Rect::new(
        note.window.x.unwrap_or(0.0),
        note.window.y.unwrap_or(0.0),
        note.window.width,
        note.window.height,
    );
    let area = windows::work_area_for(&app, &here);
    let (w, h) = clamp_note_size((width, height), min, (area.width, area.height));
    let window = app.get_webview_window(&windows::note_label(&id));
    match size_plan(window.is_some(), note.window.collapsed) {
        SizePlan::Live => {
            if let Some(window) = &window {
                resize_in_place(&app, window, (w, h), false)?;
            }
        }
        plan => {
            // Saved first: the strip's own resize event then only repeats its width.
            state.with_db(|db| db.set_window_size(&id, w, h))?;
            if let (SizePlan::SavedAndStrip, Some(window)) = (plan, &window)
                && let Err(e) = resize_in_place(&app, window, (w, COLLAPSED_HEIGHT), true)
            {
                // The strip kept its old width; its next move would save that
                // width with the new height. Put the saved size back instead.
                let (old_w, old_h) = (note.window.width, note.window.height);
                if let Err(undo) = state.with_db(|db| db.set_window_size(&id, old_w, old_h)) {
                    eprintln!(
                        "DeskNotes: could not restore a note's saved size: {}",
                        undo.message
                    );
                }
                return Err(e);
            }
        }
    }
    // Whole pixels by construction, inside the u32 range after clamping.
    Ok(NoteSize {
        width: w as u32,
        height: h as u32,
    })
}

/// Resize an open note window, and move it back inside its screen when the new
/// size would make it run off (only where positioning is supported). `strip`:
/// the window is a collapsed note's header strip, which only moves sideways.
/// Only a failed resize is an error: a failed move is logged, since the window
/// has its new size either way.
fn resize_in_place(
    app: &AppHandle,
    window: &WebviewWindow,
    size: (f64, f64),
    strip: bool,
) -> IpcResult<()> {
    let current = windows::geometry_of(
        window.scale_factor(),
        window.outer_position(),
        window.inner_size(),
    );
    window.set_size(LogicalSize::new(size.0, size.1))?;
    if let (true, Some(current)) = (window_positioning_supported(), current)
        && let Some((x, y)) = moved_to_fit(current, size, strip, &windows::work_areas(app))
        && let Err(e) = window.set_position(LogicalPosition::new(x, y))
    {
        eprintln!("DeskNotes: could not move a resized note back on screen: {e}");
    }
    Ok(())
}

/// Where a note at `current` must move to once it has `size`, so that it is
/// fully inside its screen (the startup rule, `keep_on_screen`); `None` when it
/// can stay. A collapsed `strip` is only moved sideways: `keep_on_screen` would
/// treat its 32 px as too short and move it up.
fn moved_to_fit(
    current: Rect,
    size: (f64, f64),
    strip: bool,
    areas: &[Rect],
) -> Option<(f64, f64)> {
    let wanted = Rect::new(current.x, current.y, size.0, size.1);
    let fitted = keep_on_screen(wanted, areas);
    let y = if strip { current.y } else { fitted.y };
    ((fitted.x, y) != (current.x, current.y)).then_some((fitted.x, y))
}

/// Installed font families, for the font picker. Empty when they cannot be
/// listed. Runs off the main thread: listing fonts can take a moment.
#[tauri::command]
pub async fn list_fonts() -> IpcResult<Vec<String>> {
    tauri::async_runtime::spawn_blocking(fonts::families)
        .await
        .map_err(|e| IpcError::new("fonts", e.to_string()))
}

/// Open the Note settings window for a note, or switch the open one to it.
/// Refused for an archived, trashed or done note (the window would close at once).
/// Async: creating a window from a synchronous command deadlocks on Windows.
#[tauri::command]
pub async fn open_note_settings(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> IpcResult<()> {
    let id = parse_note_id(&id)?;
    let note = state.with_db(|db| db.get_note(&id))?;
    super::notes::ensure_may_have_window(&note)?;
    windows::note_settings::open_note_settings(&app, &id)
}

/// How long to wait for a closed note window to be gone before reopening it.
const GONE_TIMEOUT: Duration = Duration::from_secs(2);

/// Whether `caller` (a window label) is the window of note `id`.
fn is_the_note_itself(caller: &str, id: &str) -> bool {
    caller == windows::note_label(id)
}

/// Close a note's window and open it again at the same place and size (a
/// window's transparency is fixed when it is created). Only the note's own
/// window may call this, after saving its text: the window is closed without
/// saving anything. A note with no open window is left alone. Closing a private
/// note's window releases its kept-open state, so it opens locked; its text has
/// been saved. A failure is also put on the manager's error list: the note
/// would otherwise stay closed until the next start without a word.
#[tauri::command]
pub async fn reopen_note(app: AppHandle, caller: WebviewWindow, id: String) -> IpcResult<()> {
    let id = parse_note_id(&id)?;
    if !is_the_note_itself(caller.label(), &id) {
        return Err(IpcError::new(
            "forbidden",
            "Only the note's own window can reopen it.",
        ));
    }
    let result = reopen(&app, &id).await;
    if let Err(e) = &result {
        windows::report_window_problem(&app, reopen_failure_message(e));
    }
    result
}

/// What the manager says when a note could not be reopened.
fn reopen_failure_message(e: &IpcError) -> String {
    format!(
        "A note window could not be reopened after its opacity changed (its text is saved; \
         open it again from the list): {}",
        e.message
    )
}

async fn reopen(app: &AppHandle, id: &str) -> IpcResult<()> {
    let label = windows::note_label(id);
    let note = app.state::<AppState>().with_db(|db| db.get_note(id))?;
    let wanted = windows::needs_transparency(&note.appearance);
    // No window, or already right: two quick crossings of 100 % ask twice.
    if !needs_reopen(windows::window_transparency(app, id), wanted) {
        return Ok(());
    }
    let id = id.to_owned();
    // Off the async runtime's workers: closing waits for the saved place to be
    // written (up to 2 s), and waiting for the window to go sleeps.
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        windows::close_note(&handle, &id)?;
        // `close_note` only asks for the window to be destroyed; it is gone once
        // the main thread has handled that. Opening before then would just focus it.
        let deadline = Instant::now() + GONE_TIMEOUT;
        while handle.get_webview_window(&label).is_some() {
            if Instant::now() >= deadline {
                return Err(IpcError::new(
                    "window",
                    "The note window did not close in time.",
                ));
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        let note = handle.state::<AppState>().with_db(|db| db.get_note(&id))?;
        // The Note settings window, if open, keeps the focus.
        windows::open_note_with_focus(&handle, &note, false)?;
        emit_changed(&handle, Some(&id), "other");
        Ok(())
    })
    .await
    .map_err(|e| IpcError::new("window", e.to_string()))?
}

/// The size to apply: whole pixels, at least `min`, at most `max` (the work
/// area of the note's screen). Anything not a usable number becomes `min`.
/// When the screen is smaller than the minimum, the minimum wins.
pub fn clamp_note_size(want: (f64, f64), min: NoteSize, max: (f64, f64)) -> (f64, f64) {
    let side = |want: f64, min: u32, max: f64| {
        let min = f64::from(min);
        let want = if want.is_finite() { want.round() } else { min };
        // `max` last-but-one so a screen smaller than the minimum cannot win.
        want.min(max.floor()).max(min)
    };
    (
        side(want.0, min.width, max.0),
        side(want.1, min.height, max.1),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    const MIN: NoteSize = NoteSize {
        width: 220,
        height: 180,
    };
    const SCREEN: (f64, f64) = (1920.0, 1040.0);

    #[test]
    fn a_size_change_is_planned_by_whether_the_note_is_open_and_collapsed() {
        assert_eq!(size_plan(true, false), SizePlan::Live);
        assert_eq!(size_plan(true, true), SizePlan::SavedAndStrip);
        assert_eq!(size_plan(false, false), SizePlan::SavedOnly);
        assert_eq!(size_plan(false, true), SizePlan::SavedOnly);
    }

    #[test]
    fn a_window_is_reopened_only_when_its_transparency_is_wrong() {
        // No window: nothing to reopen.
        assert!(!needs_reopen(None, true));
        assert!(!needs_reopen(None, false));
        // Already right, e.g. the second of two quick crossings of 100 %.
        assert!(!needs_reopen(Some(true), true));
        assert!(!needs_reopen(Some(false), false));
        // Wrong, including after an earlier reopen that did not happen.
        assert!(needs_reopen(Some(false), true));
        assert!(needs_reopen(Some(true), false));
    }

    #[test]
    fn clamp_note_size_keeps_inside_min_and_screen() {
        assert_eq!(clamp_note_size((10.0, 10.0), MIN, SCREEN), (220.0, 180.0));
        assert_eq!(
            clamp_note_size((5000.0, 5000.0), MIN, SCREEN),
            (1920.0, 1040.0)
        );
        assert_eq!(
            clamp_note_size((f64::NAN, -40.0), MIN, SCREEN),
            (220.0, 180.0)
        );
        assert_eq!(
            clamp_note_size((f64::INFINITY, f64::NEG_INFINITY), MIN, SCREEN),
            (220.0, 180.0)
        );
        assert_eq!(clamp_note_size((300.4, 280.5), MIN, SCREEN), (300.0, 281.0));
        // A screen smaller than the minimum never makes the note smaller.
        assert_eq!(
            clamp_note_size((300.0, 300.0), MIN, (200.0, 100.0)),
            (220.0, 180.0)
        );
    }

    const LAPTOP: Rect = Rect {
        x: 0.0,
        y: 32.0,
        width: 1920.0,
        height: 1048.0,
    };

    #[test]
    fn a_note_grown_past_the_screen_edge_moves_back_inside() {
        let areas = [LAPTOP];
        // Stays put when it still fits.
        let at = Rect::new(100.0, 100.0, 300.0, 280.0);
        assert_eq!(moved_to_fit(at, (800.0, 600.0), false, &areas), None);
        // Grown over the right and bottom edges: moved up and left, not shrunk.
        let at = Rect::new(1700.0, 900.0, 300.0, 280.0);
        assert_eq!(
            moved_to_fit(at, (600.0, 500.0), false, &areas),
            Some((1320.0, 580.0))
        );
        // Larger than the screen: top-left of the area, so the header stays reachable.
        assert_eq!(
            moved_to_fit(at, (5000.0, 5000.0), false, &areas),
            Some((0.0, 32.0))
        );
    }

    #[test]
    fn a_widened_strip_only_moves_sideways() {
        let areas = [LAPTOP];
        let strip = Rect::new(1700.0, 1060.0, 300.0, 32.0);
        assert_eq!(
            moved_to_fit(strip, (600.0, 32.0), true, &areas),
            Some((1320.0, 1060.0))
        );
        let fits = Rect::new(100.0, 1060.0, 300.0, 32.0);
        assert_eq!(moved_to_fit(fits, (600.0, 32.0), true, &areas), None);
    }

    #[test]
    fn only_the_note_itself_may_reopen_it() {
        let id = "0b9a5f0e-6a43-4c1e-9d6e-3f6a5b7c8d90";
        let other = "1c0b6a1f-7b54-4d2f-8e7f-4a7b6c8d9e01";
        assert!(is_the_note_itself(&windows::note_label(id), id));
        assert!(!is_the_note_itself(&windows::note_label(other), id));
        assert!(!is_the_note_itself("manager", id));
        assert!(!is_the_note_itself("note_settings", id));
        assert!(!is_the_note_itself(id, id));
    }

    #[test]
    fn a_failed_reopen_tells_the_owner_what_happened() {
        let e = IpcError::new("window", "The note window did not close in time.");
        let message = reopen_failure_message(&e);
        assert!(message.contains("could not be reopened"));
        assert!(message.contains("did not close in time"));
    }
}
