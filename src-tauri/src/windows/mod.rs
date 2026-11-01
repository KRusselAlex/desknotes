//! Window management: one manager window plus one window per visible note.
//! Windows are only ever created here, never from the webview.

pub mod geometry;

use desknotes_core::geometry::{Rect, keep_on_screen};
use desknotes_core::{MIN_HEIGHT, MIN_WIDTH, Note};
use serde::Serialize;
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindowBuilder,
    Window, WindowEvent,
};

use crate::platform::window_positioning_supported;
use crate::state::AppState;

pub const MANAGER: &str = "manager";
pub const NOTE_PREFIX: &str = "note-";
pub const NOTES_CHANGED: &str = "notes-changed";
pub const APP_WILL_QUIT: &str = "app-will-quit";
/// Sent to the manager when quitting was cancelled because notes hold unsaved text.
pub const QUIT_BLOCKED: &str = "quit-blocked";
/// Sent to a note window: perform "hide", "archive" or "trash" after saving.
pub const NOTE_ACTION: &str = "note-action";

/// Payload of `notes-changed`. `kind` is "content" for text saves (the
/// manager refreshes titles) and "other" for everything else.
#[derive(Clone, Serialize)]
pub struct NotesChanged {
    pub id: Option<String>,
    pub kind: &'static str,
}

pub fn emit_changed(app: &AppHandle, id: Option<&str>, kind: &'static str) {
    let payload = NotesChanged {
        id: id.map(str::to_owned),
        kind,
    };
    if let Err(e) = app.emit(NOTES_CHANGED, payload) {
        eprintln!("DeskNotes: could not notify windows: {e}");
    }
}

pub fn note_label(id: &str) -> String {
    format!("{NOTE_PREFIX}{id}")
}

fn note_id_from_label(label: &str) -> Option<&str> {
    label.strip_prefix(NOTE_PREFIX)
}

/// Work areas (monitor minus panels) in logical pixels, primary first.
fn work_areas(app: &AppHandle) -> Vec<Rect> {
    let to_rect = |m: &tauri::Monitor| {
        let scale = m.scale_factor();
        let area = m.work_area();
        let pos = area.position.to_logical::<f64>(scale);
        let size = area.size.to_logical::<f64>(scale);
        Rect::new(pos.x, pos.y, size.width, size.height)
    };
    let mut areas = Vec::new();
    if let Ok(Some(primary)) = app.primary_monitor() {
        areas.push(to_rect(&primary));
    }
    for monitor in app.available_monitors().unwrap_or_default() {
        let rect = to_rect(&monitor);
        if !areas.contains(&rect) {
            areas.push(rect);
        }
    }
    if areas.is_empty() {
        areas.push(Rect::new(0.0, 0.0, 1280.0, 800.0));
    }
    areas
}

fn geometry_of(
    scale: tauri::Result<f64>,
    position: tauri::Result<PhysicalPosition<i32>>,
    size: tauri::Result<PhysicalSize<u32>>,
) -> Option<Rect> {
    let scale = scale.ok()?;
    let pos = position.ok()?.to_logical::<f64>(scale);
    let size = size.ok()?.to_logical::<f64>(scale);
    Some(Rect::new(pos.x, pos.y, size.width, size.height))
}

/// Labels of all open note windows.
pub fn open_note_labels(app: &AppHandle) -> std::collections::HashSet<String> {
    app.webview_windows()
        .into_keys()
        .filter(|label| label.starts_with(NOTE_PREFIX))
        .collect()
}

/// If the note's window is open and the request did not come from it (for
/// example from the manager), hand the action to that window. It saves first
/// and then performs the action itself, or stays open showing the save error.
/// Returns true when the action was handed over.
pub fn delegate_to_note(app: &AppHandle, caller_label: &str, note_id: &str, action: &str) -> bool {
    let label = note_label(note_id);
    if caller_label == label || app.get_webview_window(&label).is_none() {
        return false;
    }
    if let Err(e) = app.emit_to(label.as_str(), NOTE_ACTION, action) {
        eprintln!("DeskNotes: could not reach the note window: {e}");
        return false;
    }
    true
}

fn open_note_windows(app: &AppHandle, except: Option<&str>) -> usize {
    app.webview_windows()
        .keys()
        .filter(|label| label.starts_with(NOTE_PREFIX) && Some(label.as_str()) != except)
        .count()
}

#[cfg(target_os = "linux")]
type RelatedView = webkit2gtk::WebView;
#[cfg(not(target_os = "linux"))]
type RelatedView = ();

fn report_window_error(app: &AppHandle, e: tauri::Error) {
    app.state::<AppState>().push_error(format!(
        "A note window could not be opened (its content is safe): {e}"
    ));
    let _ = show_manager(app);
}

/// Open (or focus) the window of a note. On Linux the window itself is created a
/// moment later on the main thread; errors then appear in the manager.
pub fn open_note(app: &AppHandle, note: &Note) -> tauri::Result<()> {
    let label = note_label(&note.id);
    if let Some(existing) = app.get_webview_window(&label) {
        existing.show()?;
        existing.unminimize()?;
        existing.set_focus()?;
        return Ok(());
    }

    let areas = work_areas(app);
    let w = &note.window;
    let (x, y) = match (w.x, w.y) {
        (Some(x), Some(y)) => (x, y),
        _ => {
            // New note: cascade from the top-left of the primary work area.
            let step = (open_note_windows(app, None) % 8) as f64 * 28.0;
            (areas[0].x + 64.0 + step, areas[0].y + 64.0 + step)
        }
    };
    let rect = keep_on_screen(Rect::new(x, y, w.width, w.height), &areas);
    let positioning = window_positioning_supported();
    let always_on_top = w.always_on_top;

    // Builds the window. Runs on the main thread (inside `with_webview` on Linux).
    let handle = app.clone();
    let build = move |related: Option<RelatedView>| -> tauri::Result<()> {
        // Requests are queued; a second one for the same note just focuses it.
        if let Some(existing) = handle.get_webview_window(&label) {
            existing.show()?;
            return existing.set_focus();
        }
        let mut builder =
            WebviewWindowBuilder::new(&handle, &label, WebviewUrl::App("index.html".into()))
                .title("DeskNotes") // never the note text: titles are visible to others
                .decorations(false)
                .resizable(true)
                // A double-click on the drag area would otherwise maximise the note,
                // and that full-screen size would be saved as its normal size.
                .maximizable(false)
                .inner_size(rect.width, rect.height)
                .min_inner_size(MIN_WIDTH, MIN_HEIGHT)
                .always_on_top(always_on_top)
                // Created hidden, shown below. tao maps a visible window *before*
                // removing its decorations, so Mutter first frames it with a 37 px
                // title bar and the note keeps that extra height, growing on every
                // restart. Mapping only after it is undecorated avoids this.
                .visible(false);
        if positioning {
            builder = builder.position(rect.x, rect.y);
        }
        #[cfg(target_os = "linux")]
        if let Some(view) = related {
            builder = builder.with_related_view(view);
        }
        #[cfg(not(target_os = "linux"))]
        let _ = related;
        let window = builder.build()?;
        window.show()?;
        window.set_focus()
    };

    // On Linux every note shares the manager's WebKit web process (a "related
    // view") instead of starting its own, which costs ~80 MiB per note
    // (docs/testing/m1-verification.md, Jira DES-24).
    #[cfg(target_os = "linux")]
    if let Some(manager) = app.get_webview_window(MANAGER) {
        let reporter = app.clone();
        manager.with_webview(move |platform| {
            if let Err(e) = build(Some(platform.inner())) {
                report_window_error(&reporter, e);
            }
        })?;
    } else {
        build(None)?;
    }
    #[cfg(not(target_os = "linux"))]
    build(None)?;

    let position = positioning.then_some((rect.x, rect.y));
    app.state::<AppState>()
        .geometry
        .update(&note.id, position, rect.width, rect.height);
    Ok(())
}

/// Save the window's final geometry and destroy it. No-op if not open.
pub fn close_note(app: &AppHandle, note_id: &str) -> tauri::Result<()> {
    let Some(window) = app.get_webview_window(&note_label(note_id)) else {
        return Ok(());
    };
    let state = app.state::<AppState>();
    if !window.is_minimized().unwrap_or(false)
        && let Some(r) = geometry_of(
            window.scale_factor(),
            window.outer_position(),
            window.inner_size(),
        )
    {
        let position = window_positioning_supported().then_some((r.x, r.y));
        state.geometry.update(note_id, position, r.width, r.height);
    }
    state.geometry.flush();
    // destroy() skips CloseRequested, so the webview's close handler is not re-entered.
    window.destroy()
}

/// Show the manager, creating it if needed.
pub fn show_manager(app: &AppHandle) -> tauri::Result<()> {
    ensure_manager(app, true)
}

fn ensure_manager(app: &AppHandle, visible: bool) -> tauri::Result<()> {
    if let Some(window) = app.get_webview_window(MANAGER) {
        if visible {
            window.show()?;
            window.unminimize()?;
            window.set_focus()?;
        }
        return Ok(());
    }
    WebviewWindowBuilder::new(app, MANAGER, WebviewUrl::App("index.html".into()))
        .title("DeskNotes")
        .inner_size(560.0, 620.0)
        .min_inner_size(400.0, 360.0)
        .center()
        .visible(visible)
        .build()?;
    Ok(())
}

/// After a note disappears, make sure the app is still reachable.
pub fn after_note_hidden(app: &AppHandle, hidden_note_id: &str) {
    let label = note_label(hidden_note_id);
    let manager_visible = app
        .get_webview_window(MANAGER)
        .and_then(|w| w.is_visible().ok())
        .unwrap_or(false);
    if open_note_windows(app, Some(&label)) == 0
        && !manager_visible
        && let Err(e) = show_manager(app)
    {
        eprintln!("DeskNotes: could not show the manager: {e}");
    }
}

/// Open saved notes and the manager at startup.
pub fn restore_on_startup(app: &AppHandle) {
    let state = app.state::<AppState>();
    let notes = match state.with_db(|db| db.notes_to_show()) {
        Ok((notes, unreadable)) => {
            for id in unreadable {
                state.push_error(format!(
                    "Note {id} could not be read and was not opened. Its data was left untouched."
                ));
            }
            notes
        }
        Err(e) if e.code == "database_unavailable" => Vec::new(), // already reported
        Err(e) => {
            state.push_error(format!("Saved notes could not be loaded: {}", e.message));
            Vec::new()
        }
    };
    // The manager comes first: note windows share its web process.
    let show_manager = notes.is_empty() || !state.errors().is_empty();
    if let Err(e) = ensure_manager(app, show_manager) {
        eprintln!("DeskNotes: could not create the manager window: {e}");
    }
    for note in &notes {
        if let Err(e) = open_note(app, note) {
            report_window_error(app, e);
        }
    }
}

pub fn on_window_event(window: &Window, event: &WindowEvent) {
    match event {
        WindowEvent::Moved(_) | WindowEvent::Resized(_) => {
            let Some(id) = note_id_from_label(window.label()) else {
                return;
            };
            if window.is_minimized().unwrap_or(false) || window.is_maximized().unwrap_or(false) {
                return;
            }
            if let Some(r) = geometry_of(
                window.scale_factor(),
                window.outer_position(),
                window.inner_size(),
            ) {
                let position = window_positioning_supported().then_some((r.x, r.y));
                window
                    .state::<AppState>()
                    .geometry
                    .update(id, position, r.width, r.height);
            }
        }
        WindowEvent::CloseRequested { api, .. } if window.label() == MANAGER => {
            // Closing the manager hides it while notes are on screen; with no
            // notes showing it quits, so no invisible process is left behind.
            api.prevent_close();
            let app = window.app_handle();
            if open_note_windows(app, None) > 0 {
                let _ = window.hide();
            } else {
                app.exit(0);
            }
        }
        _ => {}
    }
}
