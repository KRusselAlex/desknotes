//! Commands behind the per-note settings window: text and background styling,
//! the note's size, and the list of installed fonts.

use std::time::{Duration, Instant};

use desknotes_core::geometry::Rect;
use desknotes_core::validation::parse_note_id;
use desknotes_core::{Appearance, COLLAPSED_HEIGHT, NoteSize};
use tauri::{AppHandle, LogicalSize, Manager, State, WebviewWindow};

use crate::error::{IpcError, IpcResult};
use crate::platform::fonts;
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

/// Whether a note window needs transparency: its opacity is below 100 %
/// (no opacity set means 100 %).
fn see_through(appearance: &Appearance) -> bool {
    appearance.opacity.is_some_and(|o| o < 100)
}

/// Style a note. Saved by the core (which validates every field), then every
/// window is told. A note window is created with transparency only when its
/// opacity is below 100 %, so crossing 100 % in either direction asks the open
/// note window to save and reopen itself (`reopen`, handled by the note).
#[tauri::command]
pub fn set_note_appearance(
    app: AppHandle,
    caller: WebviewWindow,
    state: State<'_, AppState>,
    id: String,
    appearance: Appearance,
) -> IpcResult<()> {
    let id = parse_note_id(&id)?;
    let was_see_through = see_through(&state.with_db(|db| db.get_note(&id))?.appearance);
    state.with_db(|db| db.set_appearance(&id, &appearance))?;
    let is_see_through = see_through(&state.with_db(|db| db.get_note(&id))?.appearance);
    emit_changed(&app, Some(&id), "other");
    if was_see_through != is_see_through {
        windows::delegate_to_note(&app, caller.label(), &id, "reopen");
    }
    Ok(())
}

/// Resize a note. The size is limited to the minimum note size and the work
/// area of the screen the note is on, and rounded to whole pixels; the size
/// applied is returned. An open, expanded note is resized live (the resize
/// event saves it); a collapsed or closed one only gets its saved size changed,
/// which is used when it is expanded or opened.
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
                window.set_size(LogicalSize::new(w, h))?;
            }
        }
        plan => {
            // Saved first: the strip's own resize event then only repeats its width.
            state.with_db(|db| db.set_window_size(&id, w, h))?;
            if let (SizePlan::SavedAndStrip, Some(window)) = (plan, &window) {
                window.set_size(LogicalSize::new(w, COLLAPSED_HEIGHT))?;
            }
        }
    }
    // Whole pixels by construction, inside the u32 range after clamping.
    Ok(NoteSize {
        width: w as u32,
        height: h as u32,
    })
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
/// Async: creating a window from a synchronous command deadlocks on Windows.
#[tauri::command]
pub async fn open_note_settings(app: AppHandle, id: String) -> IpcResult<()> {
    let id = parse_note_id(&id)?;
    windows::note_settings::open_note_settings(&app, &id)
}

/// How long to wait for a closed note window to be gone before reopening it.
const GONE_TIMEOUT: Duration = Duration::from_secs(2);

/// Close a note's window and open it again at the same place and size (a
/// window's transparency is fixed when it is created). The note window calls
/// this itself after saving its text. A note with no open window is left alone.
/// Closing a private note's window releases its kept-open state, so it opens
/// locked; its text has been saved.
#[tauri::command]
pub async fn reopen_note(app: AppHandle, id: String) -> IpcResult<()> {
    let id = parse_note_id(&id)?;
    let label = windows::note_label(&id);
    if app.get_webview_window(&label).is_none() {
        return Ok(());
    }
    windows::close_note(&app, &id)?;
    // `close_note` only asks for the window to be destroyed; it is gone once
    // the main thread has handled that. Opening before then would just focus it.
    // Off the async runtime's workers: this sleeps.
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
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
        windows::open_note(&handle, &note)?;
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
    fn a_collapsed_open_note_gets_its_strip_resized_as_well_as_saved() {
        assert_eq!(size_plan(true, false), SizePlan::Live);
        assert_eq!(size_plan(true, true), SizePlan::SavedAndStrip);
        assert_eq!(size_plan(false, false), SizePlan::SavedOnly);
        assert_eq!(size_plan(false, true), SizePlan::SavedOnly);
    }

    #[test]
    fn only_an_opacity_below_100_needs_a_see_through_window() {
        let with = |opacity| Appearance {
            opacity,
            ..Appearance::default()
        };
        assert!(!see_through(&with(None)));
        assert!(!see_through(&with(Some(100))));
        assert!(see_through(&with(Some(95))));
        assert!(see_through(&with(Some(80))));
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
}
