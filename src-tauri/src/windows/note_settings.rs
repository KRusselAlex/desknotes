//! The Note settings window: one at a time, placed beside the note it styles.
//! Like every window it is only ever created here, never from the webview.

use desknotes_core::geometry::Rect;
use desknotes_core::validation::parse_note_id;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

use super::{
    Building, NOTE_SETTINGS, NOTE_SETTINGS_NOTE, build_sharing_process, geometry_of, note_label,
    work_area_for,
};
use crate::error::{IpcError, IpcResult};
use crate::platform::window_positioning_supported;
use crate::state::AppState;

const TITLE: &str = "Note settings"; // never the note text
const WIDTH: f64 = 400.0;
const MAX_HEIGHT: f64 = 640.0;
/// Room left for panels and the window's own frame when it fills the screen.
const SCREEN_MARGIN: f64 = 48.0;
const MIN_SIZE: (f64, f64) = (360.0, 400.0);
/// Gap between the note and the settings window.
const GAP: f64 = 12.0;

/// Page loaded by a new Note settings window; the webview reads `note` from it.
/// The id is checked first: it ends up in a URL.
fn note_settings_url(id: &str) -> IpcResult<String> {
    let id = parse_note_id(id)?;
    Ok(format!("index.html?note={id}"))
}

/// Inner height of the window on a screen with this work area height: never
/// below the window's own minimum, even on a very small screen.
fn window_height(area_height: f64) -> f64 {
    MAX_HEIGHT.min(area_height - SCREEN_MARGIN).max(MIN_SIZE.1)
}

/// Where the window of `size` goes (top-left): right of the note, with a gap,
/// when it fits in the work area `area`; otherwise left of it; otherwise
/// centred in the area. Beside the note it lines up with the note's top edge,
/// moved up if it would run off the bottom of the area.
pub fn place_beside(note: Rect, size: (f64, f64), area: Rect) -> (f64, f64) {
    let (width, height) = size;
    let y = note.y.min(area.bottom() - height).max(area.y);
    let right = note.right() + GAP;
    if right + width <= area.right() {
        return (right, y);
    }
    let left = note.x - GAP - width;
    if left >= area.x {
        return (left, y);
    }
    (
        (area.x + (area.width - width) / 2.0).max(area.x),
        (area.y + (area.height - height) / 2.0).max(area.y),
    )
}

/// Where the note is: its window when open, else where it was saved.
fn note_rect(app: &AppHandle, id: &str) -> IpcResult<Rect> {
    if let Some(w) = app.get_webview_window(&note_label(id))
        && let Some(r) = geometry_of(w.scale_factor(), w.outer_position(), w.inner_size())
    {
        return Ok(r);
    }
    let note = app.state::<AppState>().with_db(|db| db.get_note(id))?;
    let w = &note.window;
    Ok(Rect::new(
        w.x.unwrap_or(0.0),
        w.y.unwrap_or(0.0),
        w.width,
        w.height,
    ))
}

/// Open the Note settings window for a note, or switch the open one to that
/// note and focus it. A new window is created hidden and shown once built (see
/// `open_note`), and shares the manager's web process (ADR-0006). `id` has been
/// checked by the command; the URL is built from it only after its own check.
pub fn open_note_settings(app: &AppHandle, id: &str) -> IpcResult<()> {
    let id = id.to_owned();
    if let Some(existing) = app.get_webview_window(NOTE_SETTINGS) {
        switch_to(app, &id)?;
        existing.show()?;
        existing.unminimize()?;
        return Ok(existing.set_focus()?);
    }

    let url = note_settings_url(&id)?;
    let note = note_rect(app, &id)?;
    let area = work_area_for(app, &note);
    let size = (WIDTH, window_height(area.height));
    let at = place_beside(note, size, area);
    let positioning = window_positioning_supported();

    let handle = app.clone();
    build_sharing_process(app, Building::NoteSettings, move |related| {
        // Requests are queued; a second one just switches the window.
        if let Some(existing) = handle.get_webview_window(NOTE_SETTINGS) {
            handle.emit_to(NOTE_SETTINGS, NOTE_SETTINGS_NOTE, &id)?;
            return existing.set_focus();
        }
        let mut builder =
            WebviewWindowBuilder::new(&handle, NOTE_SETTINGS, WebviewUrl::App(url.into()))
                .title(TITLE)
                .inner_size(size.0, size.1)
                .min_inner_size(MIN_SIZE.0, MIN_SIZE.1)
                .visible(false);
        builder = if positioning {
            builder.position(at.0, at.1)
        } else {
            builder.center()
        };
        #[cfg(target_os = "linux")]
        if let Some(view) = related {
            builder = builder.with_related_view(view);
        }
        #[cfg(not(target_os = "linux"))]
        let _ = related;
        let window = builder.build()?;
        window.show()?;
        window.set_focus()
    })?;
    Ok(())
}

/// Tell the open settings window to show another note.
fn switch_to(app: &AppHandle, id: &str) -> IpcResult<()> {
    app.emit_to(NOTE_SETTINGS, NOTE_SETTINGS_NOTE, id)
        .map_err(|e| IpcError::new("window", e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    const AREA: Rect = Rect {
        x: 0.0,
        y: 0.0,
        width: 1920.0,
        height: 1040.0,
    };
    const SIZE: (f64, f64) = (400.0, 640.0);

    #[test]
    fn place_beside_prefers_right_then_left_then_centre() {
        // Room on the right: 12 px gap, same top as the note.
        let note = Rect::new(100.0, 80.0, 300.0, 280.0);
        assert_eq!(place_beside(note, SIZE, AREA), (412.0, 80.0));

        // No room on the right (note near the right edge): on the left.
        let note = Rect::new(1500.0, 80.0, 300.0, 280.0);
        assert_eq!(place_beside(note, SIZE, AREA), (1088.0, 80.0));

        // No room on either side: centred in the area.
        let note = Rect::new(300.0, 80.0, 1300.0, 280.0);
        assert_eq!(place_beside(note, SIZE, AREA), (760.0, 200.0));

        // Beside the note, never below the bottom of the area.
        let note = Rect::new(100.0, 900.0, 300.0, 280.0);
        assert_eq!(place_beside(note, SIZE, AREA), (412.0, 400.0));

        // A work area that does not start at the origin (second screen).
        let second = Rect::new(1920.0, 30.0, 1280.0, 1000.0);
        let note = Rect::new(2000.0, 10.0, 300.0, 280.0);
        assert_eq!(place_beside(note, SIZE, second), (2312.0, 30.0));
    }

    #[test]
    fn note_settings_url_carries_the_note_id() {
        let id = "0b9a5f0e-6a43-4c1e-9d6e-3f6a5b7c8d90";
        assert_eq!(
            note_settings_url(id).unwrap(),
            format!("index.html?note={id}")
        );
        // Anything that is not a UUID never reaches a URL.
        for bad in ["", "abc", "../x", "0b9a5f0e&x=1", "index.html?note=1"] {
            assert_eq!(
                note_settings_url(bad).unwrap_err().code,
                "validation",
                "{bad:?}"
            );
        }
    }

    #[test]
    fn the_window_is_at_most_640_high_and_fits_the_screen_down_to_its_minimum() {
        assert_eq!(window_height(1040.0), 640.0);
        assert_eq!(window_height(600.0), 552.0);
        // A tiny screen: the window keeps its minimum height.
        assert_eq!(window_height(300.0), MIN_SIZE.1);
    }

    /// The window may close itself and nothing more: no link opening (default.json
    /// carries `opener:allow-open-url`), and no other window may close itself.
    #[test]
    fn the_note_settings_window_has_its_own_small_capability() {
        let read = |s: &str| serde_json::from_str::<serde_json::Value>(s).unwrap();
        let default = read(include_str!("../../capabilities/default.json"));
        let own = read(include_str!("../../capabilities/note-settings.json"));
        let windows = |c: &serde_json::Value| -> Vec<String> {
            c["windows"]
                .as_array()
                .unwrap()
                .iter()
                .map(|w| w.as_str().unwrap().to_owned())
                .collect()
        };
        assert!(!windows(&default).iter().any(|w| w == NOTE_SETTINGS));
        assert_eq!(windows(&own), [NOTE_SETTINGS]);
        let permissions = own["permissions"].to_string();
        assert!(permissions.contains("core:default"));
        assert!(permissions.contains("core:window:allow-close"));
        assert!(!permissions.contains("opener"));
    }
}
