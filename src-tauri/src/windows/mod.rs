//! Window management: one manager window plus one window per visible note.
//! Windows are only ever created here, never from the webview.

pub mod geometry;
mod image_drop;
pub mod note_settings;

use desknotes_core::geometry::{Rect, keep_on_screen};
use desknotes_core::{COLLAPSED_HEIGHT, Note, NoteSize};
use serde::Serialize;
use tauri::{
    AppHandle, DragDropEvent, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl,
    WebviewWindowBuilder, Window, WindowEvent,
};

use crate::platform::window_positioning_supported;
use crate::state::AppState;

pub const MANAGER: &str = "manager";
pub const NOTE_PREFIX: &str = "note-";
pub const NOTES_CHANGED: &str = "notes-changed";
/// Asks every note window to save now and answer with `quit_ready`
/// (used before quitting, exporting and restoring).
pub const SAVE_ALL_NOTES: &str = "save-all-notes";
/// Sent to the manager when quitting was cancelled because notes hold unsaved text.
pub const QUIT_BLOCKED: &str = "quit-blocked";
/// Sent to a note window: perform "hide", "archive", "trash" or "complete" after saving.
pub const NOTE_ACTION: &str = "note-action";
/// Sent to every window when the app-wide note appearance changes; the payload
/// is the saved `AppAppearance`.
pub const APP_APPEARANCE_CHANGED: &str = "app-appearance-changed";
/// Sent to the note settings window when a note window changes size.
pub const NOTE_RESIZED: &str = "note-resized";
/// Sent to an open note settings window: show the note whose id is the payload.
pub const NOTE_SETTINGS_NOTE: &str = "note-settings-note";
/// Sent to every window when a reminder was set, removed, fired, snoozed or
/// dismissed. The payload names the note (or none when several changed); never a title.
pub const REMINDERS_CHANGED: &str = "reminders-changed";

/// Payload of `note-resized`: the note's new size in logical pixels.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteResized {
    pub id: String,
    pub width: f64,
    pub height: f64,
}

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
    // Trash, restore, purge and a backup restore change which reminders can fire.
    // Text saves ("content") never do.
    if kind != "content" {
        crate::reminders::wake(app);
    }
}

/// Payload of `reminders-changed`.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemindersChanged {
    pub note_id: Option<String>,
}

pub fn emit_reminders_changed(app: &AppHandle, note_id: Option<&str>) {
    let payload = RemindersChanged {
        note_id: note_id.map(str::to_owned),
    };
    if let Err(e) = app.emit(REMINDERS_CHANGED, payload) {
        eprintln!("DeskNotes: could not notify windows of reminders: {e}");
    }
}

/// Tell every window the app-wide appearance now has this (normalised) value.
pub fn emit_app_appearance_changed(app: &AppHandle, appearance: &desknotes_core::AppAppearance) {
    if let Err(e) = app.emit(APP_APPEARANCE_CHANGED, appearance) {
        eprintln!("DeskNotes: could not notify windows of the appearance: {e}");
    }
}

pub fn note_label(id: &str) -> String {
    format!("{NOTE_PREFIX}{id}")
}

fn note_id_from_label(label: &str) -> Option<&str> {
    label.strip_prefix(NOTE_PREFIX)
}

/// Work areas (monitor minus panels) in logical pixels, primary first.
pub(crate) fn work_areas(app: &AppHandle) -> Vec<Rect> {
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

/// The work area that shares the most with `rect`; the first one (the
/// primary monitor) when `rect` touches none. `areas` is never empty.
pub(crate) fn best_area(rect: &Rect, areas: &[Rect]) -> Rect {
    areas
        .iter()
        .copied()
        .filter(|a| rect.overlap_area(a) > 0.0)
        .max_by(|a, b| rect.overlap_area(a).total_cmp(&rect.overlap_area(b)))
        .unwrap_or(areas[0])
}

/// The work area of the screen a note sits on. `rect` is where the note is,
/// open or not.
pub(crate) fn work_area_for(app: &AppHandle, rect: &Rect) -> Rect {
    best_area(rect, &work_areas(app))
}

pub(crate) fn geometry_of(
    scale: tauri::Result<f64>,
    position: tauri::Result<PhysicalPosition<i32>>,
    size: tauri::Result<PhysicalSize<u32>>,
) -> Option<Rect> {
    let scale = scale.ok()?;
    let pos = position.ok()?.to_logical::<f64>(scale);
    let size = size.ok()?.to_logical::<f64>(scale);
    Some(Rect::new(pos.x, pos.y, size.width, size.height))
}

/// Note ids after a save-all round.
#[derive(Debug, Default)]
pub struct SaveAllOutcome {
    /// Windows that answered that their text could not be saved.
    pub unsaved: Vec<String>,
    /// Windows that did not answer in time.
    pub silent: Vec<String>,
}

/// Ask every open note window to save and wait (blocking, at most `timeout`)
/// for their answers. Never call it on the main thread.
pub fn save_all_open_notes_detailed(
    app: &AppHandle,
    timeout: std::time::Duration,
) -> SaveAllOutcome {
    let labels = open_note_labels(app);
    if labels.is_empty() {
        return SaveAllOutcome::default();
    }
    let outcome = app.state::<AppState>().quit.run(
        labels,
        || {
            let _ = app.emit(SAVE_ALL_NOTES, ());
        },
        timeout,
    );
    let ids = |labels: Vec<String>| -> Vec<String> {
        labels
            .iter()
            .filter_map(|l| note_id_from_label(l).map(str::to_owned))
            .collect()
    };
    SaveAllOutcome {
        unsaved: ids(outcome.unsaved),
        silent: ids(outcome.silent),
    }
}

/// Ask every open note window to save and wait (blocking, at most `timeout`).
/// Returns the ids of the notes that answered that their text is not saved.
/// Windows that never answer are not included: an unresponsive webview cannot
/// save anyway, and it must not block quitting forever. Never call it on the
/// main thread.
pub fn save_all_open_notes(app: &AppHandle, timeout: std::time::Duration) -> Vec<String> {
    save_all_open_notes_detailed(app, timeout).unsaved
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
    report_window_problem(
        app,
        format!("A note window could not be opened (its content is safe): {e}"),
    );
}

/// Tell the owner about a window that could not be (re)opened: the message goes
/// on the manager's error list and the manager is shown.
pub(crate) fn report_window_problem(app: &AppHandle, message: String) {
    app.state::<AppState>().push_error(message);
    let _ = show_manager(app);
}

/// Run `build` so the new window shares the manager's WebKit web process (a
/// "related view") instead of starting its own, which costs ~80 MiB per window
/// (ADR-0006). On Linux `build` runs a moment later on the main thread and its
/// errors are reported in the manager.
fn build_sharing_process<F>(app: &AppHandle, build: F) -> tauri::Result<()>
where
    F: FnOnce(Option<RelatedView>) -> tauri::Result<()> + Send + 'static,
{
    #[cfg(target_os = "linux")]
    if let Some(manager) = app.get_webview_window(MANAGER) {
        let reporter = app.clone();
        return manager.with_webview(move |platform| {
            if let Err(e) = build(Some(platform.inner())) {
                report_window_error(&reporter, e);
            }
        });
    }
    build(None)
}

pub const SETTINGS: &str = "settings";
/// The per-note settings window (one at a time). The label deliberately does
/// not start with `NOTE_PREFIX` ("note-"): code keyed on that prefix would take
/// this window for a note.
pub const NOTE_SETTINGS: &str = "note_settings";
/// Sent to an open Settings window: show the section named in the payload.
pub const SETTINGS_SECTION: &str = "settings-section";

/// Sections Settings can be opened at (R19). "privacy-new-pin" opens Privacy at
/// "choose a new PIN" after a forgotten-PIN proof; `choose_new_pin` still
/// refuses without that proof, so the name grants nothing by itself.
pub const SETTINGS_SECTIONS: [&str; 6] = [
    "general",
    "appearance",
    "privacy",
    "privacy-new-pin",
    "backup",
    "about",
];

/// The known section called `name`, or `None`.
pub fn settings_section(name: &str) -> Option<&'static str> {
    SETTINGS_SECTIONS.iter().copied().find(|s| *s == name)
}

/// Page loaded by a new Settings window; the webview reads `section` from it.
fn settings_url(section: Option<&'static str>) -> String {
    match section {
        Some(s) => format!("index.html?section={s}"),
        None => "index.html".into(),
    }
}

/// Open (or focus) the Settings window (design S1–S4, 680 × 520), at `section`
/// when given (one of [`SETTINGS_SECTIONS`]).
pub fn open_settings(app: &AppHandle, section: Option<&'static str>) -> tauri::Result<()> {
    if let Some(existing) = app.get_webview_window(SETTINGS) {
        existing.show()?;
        existing.unminimize()?;
        if let Some(s) = section {
            app.emit_to(SETTINGS, SETTINGS_SECTION, s)?;
        }
        return existing.set_focus();
    }
    let handle = app.clone();
    build_sharing_process(app, move |related| {
        if let Some(existing) = handle.get_webview_window(SETTINGS) {
            if let Some(s) = section {
                handle.emit_to(SETTINGS, SETTINGS_SECTION, s)?;
            }
            return existing.set_focus();
        }
        let url = WebviewUrl::App(settings_url(section).into());
        let mut builder = WebviewWindowBuilder::new(&handle, SETTINGS, url)
            .title("Settings")
            .inner_size(680.0, 520.0)
            .min_inner_size(560.0, 420.0)
            .center();
        #[cfg(target_os = "linux")]
        if let Some(view) = related {
            builder = builder.with_related_view(view);
        }
        #[cfg(not(target_os = "linux"))]
        let _ = related;
        builder.build().map(|_| ())
    })
}

/// Open (or focus) the window of a note. On Linux the window itself is created a
/// moment later on the main thread; errors then appear in the manager.
pub fn open_note(app: &AppHandle, note: &Note) -> tauri::Result<()> {
    open_note_with_focus(app, note, true)
}

/// `open_note`, but the window may be opened without taking the focus. A note
/// recreated for the opacity switch (`reopen_note`) is opened that way: the
/// owner is working in the Note settings window, which keeps the focus (and
/// stays in front of the note) when it is open.
pub fn open_note_with_focus(app: &AppHandle, note: &Note, focus: bool) -> tauri::Result<()> {
    let label = note_label(&note.id);
    if let Some(existing) = app.get_webview_window(&label) {
        existing.show()?;
        existing.unminimize()?;
        if focus {
            existing.set_focus()?;
        }
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
    let collapsed = w.collapsed;
    // Transparency is a creation-time property of the window, so only a note
    // below 100 % opacity gets it; crossing 100 % reopens the window.
    let transparent = note.appearance.opacity.unwrap_or(100) < 100;

    // Builds the window. Runs on the main thread (inside `with_webview` on Linux).
    let handle = app.clone();
    let note_id = note.id.clone();
    let build = move |related: Option<RelatedView>| -> tauri::Result<()> {
        // Requests are queued; a second one for the same note just focuses it.
        if let Some(existing) = handle.get_webview_window(&label) {
            existing.show()?;
            return if focus { existing.set_focus() } else { Ok(()) };
        }
        // Read here, on the main thread like `set_min_note_size`, so a change made
        // while this build was queued is not missed. A smaller note opens at the
        // minimum; GTK's resize event then saves that size.
        let min = min_note_size(&handle);
        let width = rect.width.max(f64::from(min.width));
        let (min_height, height) = if collapsed {
            (COLLAPSED_HEIGHT, COLLAPSED_HEIGHT)
        } else {
            (
                f64::from(min.height),
                rect.height.max(f64::from(min.height)),
            )
        };
        let mut builder =
            WebviewWindowBuilder::new(&handle, &label, WebviewUrl::App("index.html".into()))
                .title("DeskNotes") // never the note text: titles are visible to others
                .decorations(false)
                .resizable(true)
                // A double-click on the drag area would otherwise maximise the note,
                // and that full-screen size would be saved as its normal size.
                .maximizable(false)
                .inner_size(width, height)
                .min_inner_size(f64::from(min.width), min_height)
                .always_on_top(always_on_top)
                // Created hidden, shown below. tao maps a visible window *before*
                // removing its decorations, so Mutter first frames it with a 37 px
                // title bar and the note keeps that extra height, growing on every
                // restart. Mapping only after it is undecorated avoids this.
                // Tauri's own drag-drop handler stays on: WebKitGTK gives the page no
                // dropped files, so Rust reads them (`image_drop`) and the webview
                // never opens a dropped file in place of the note.
                .visible(false);
        if transparent {
            builder = builder.transparent(true);
        }
        if positioning {
            builder = builder.position(rect.x, rect.y);
        }
        if collapsed {
            builder = builder.max_inner_size(COLLAPSED_MAX_WIDTH, COLLAPSED_HEIGHT);
        }
        #[cfg(target_os = "linux")]
        if let Some(view) = related {
            builder = builder.with_related_view(view);
        }
        #[cfg(not(target_os = "linux"))]
        let _ = related;
        let window = builder.build()?;
        // Record where and how big it opened (no resize event fires for that).
        // While collapsed, the core keeps the saved height.
        let position = positioning.then_some((rect.x, rect.y));
        let saved_height = rect.height.max(f64::from(min.height));
        handle
            .state::<AppState>()
            .geometry
            .update(&note_id, position, width, saved_height);
        window.show()?;
        focus_after_show(&handle, &window, focus)
    };

    build_sharing_process(app, build)
}

/// After a note window is shown: focus it, or (`focus` false) give the focus
/// back to the Note settings window when that is open, since showing a window
/// makes the window manager focus it and put it in front.
fn focus_after_show(
    app: &AppHandle,
    window: &tauri::WebviewWindow,
    focus: bool,
) -> tauri::Result<()> {
    if focus {
        return window.set_focus();
    }
    match app.get_webview_window(NOTE_SETTINGS) {
        Some(settings) => settings.set_focus(),
        None => Ok(()),
    }
}

/// Roll a note window up to its header strip, or back to `height`.
///
/// The window stays resizable: a non-resizable GTK window is forced to its
/// content's natural size (~200 px for a WebKit view). Equal minimum and maximum
/// heights pin the strip to 32 px while still allowing the width to change.
pub fn apply_collapsed(
    window: &tauri::WebviewWindow,
    collapsed: bool,
    width: f64,
    height: f64,
    min: NoteSize,
) -> tauri::Result<()> {
    let (min_width, min_height) = (f64::from(min.width), f64::from(min.height));
    if collapsed {
        window.set_min_size(Some(tauri::LogicalSize::new(min_width, COLLAPSED_HEIGHT)))?;
        window.set_max_size(Some(tauri::LogicalSize::new(
            COLLAPSED_MAX_WIDTH,
            COLLAPSED_HEIGHT,
        )))?;
        window.set_size(tauri::LogicalSize::new(width, COLLAPSED_HEIGHT))
    } else {
        window.set_max_size(None::<tauri::LogicalSize<f64>>)?;
        window.set_size(tauri::LogicalSize::new(
            width.max(min_width),
            height.max(min_height),
        ))?;
        window.set_min_size(Some(tauri::LogicalSize::new(min_width, min_height)))
    }
}

/// The "Minimum note size" setting, or the floor if the database cannot be read.
pub fn min_note_size(app: &AppHandle) -> NoteSize {
    app.state::<AppState>()
        .with_db(|db| db.min_note_size())
        .unwrap_or(NoteSize::FLOOR)
}

/// Give every open note window a new minimum size. GTK grows windows that are
/// smaller, and the resize is saved like any other. Collapsed notes keep their strip.
/// Best effort: the setting is already saved, so one failing window (closing at
/// that moment, say) is logged and skipped; it gets the minimum when reopened.
pub fn apply_min_note_size(app: &AppHandle, min: NoteSize) {
    let state = app.state::<AppState>();
    for (label, window) in app.webview_windows() {
        let Some(id) = label.strip_prefix(NOTE_PREFIX) else {
            continue;
        };
        // Without the collapsed state, a minimum height could fight the strip's maximum.
        let Ok(note) = state.with_db(|db| db.get_note(id)) else {
            continue;
        };
        let height = if note.window.collapsed {
            COLLAPSED_HEIGHT
        } else {
            f64::from(min.height)
        };
        let size = tauri::LogicalSize::new(f64::from(min.width), height);
        if let Err(e) = window.set_min_size(Some(size)) {
            eprintln!("DeskNotes: could not apply the minimum note size: {e}");
        }
    }
}

/// Widest a collapsed strip may be stretched.
const COLLAPSED_MAX_WIDTH: f64 = 4096.0;

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

/// Whether the manager is shown at startup rather than only created: when no
/// note opens (so DeskNotes is reachable), when there are errors to report, and
/// when "The PIN was reset on …" is waiting to be seen (design D11) — notes on
/// screen must not hide that notice, which only the manager shows.
fn manager_shown_at_startup(notes_to_show: usize, has_errors: bool, pin_reset: bool) -> bool {
    notes_to_show == 0 || has_errors || pin_reset
}

/// Where a window of `width` x `height` sits centred in `area`.
fn centred_in(area: &Rect, width: f64, height: f64) -> (f64, f64) {
    (
        area.x + (area.width - width) / 2.0,
        area.y + (area.height - height) / 2.0,
    )
}

/// On the very first start, create the welcome note and save it centred on the
/// primary screen, so it opens there like a restored note. A failure is only
/// logged: start-up must never wait on, or report, the welcome note.
fn place_welcome_note(app: &AppHandle, state: &AppState) {
    match state.with_db(|db| db.create_welcome_note()) {
        Ok(Some(note)) => {
            let area = work_areas(app)[0];
            let (x, y) = centred_in(&area, note.window.width, note.window.height);
            let position = window_positioning_supported().then_some((x, y));
            if let Err(e) = state.with_db(|db| {
                db.set_window_geometry(&note.id, position, note.window.width, note.window.height)
            }) && e.code != crate::state::DATABASE_UNAVAILABLE
            {
                // DATABASE_UNAVAILABLE is already reported.
                eprintln!("DeskNotes: could not place the welcome note: {}", e.message);
            }
        }
        Ok(None) => {}
        Err(e) if e.code == crate::state::DATABASE_UNAVAILABLE => {} // already reported
        Err(e) => eprintln!(
            "DeskNotes: could not create the welcome note: {}",
            e.message
        ),
    }
}

/// Open saved notes and the manager at startup.
pub fn restore_on_startup(app: &AppHandle) {
    let state = app.state::<AppState>();
    place_welcome_note(app, &state);
    let notes = match state.with_db(|db| db.notes_to_show()) {
        Ok((notes, unreadable)) => {
            for id in unreadable {
                state.push_error(format!(
                    "Note {id} could not be read and was not opened. Its data was left untouched."
                ));
            }
            notes
        }
        Err(e) if e.code == crate::state::DATABASE_UNAVAILABLE => Vec::new(), // already reported
        Err(e) => {
            state.push_error(format!("Saved notes could not be loaded: {}", e.message));
            Vec::new()
        }
    };
    // A failure to read it is not a reason to show the manager: it is reported
    // when the manager asks for the privacy status.
    let pin_reset = state
        .with_db(|db| db.pin_reset_at())
        .is_ok_and(|at| at.is_some());
    // The manager comes first: note windows share its web process.
    let show_manager = manager_shown_at_startup(notes.len(), !state.errors().is_empty(), pin_reset);
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
            let resized = matches!(event, WindowEvent::Resized(_));
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
                // The note settings window follows the size while it is open.
                // A collapsed strip is not the note's size: leave it out.
                if resized && r.height > COLLAPSED_HEIGHT + 1.0 {
                    let app = window.app_handle();
                    if app.get_webview_window(NOTE_SETTINGS).is_some() {
                        let payload = NoteResized {
                            id: id.to_owned(),
                            width: r.width,
                            height: r.height,
                        };
                        if let Err(e) = app.emit_to(NOTE_SETTINGS, NOTE_RESIZED, payload) {
                            eprintln!("DeskNotes: could not notify the note settings: {e}");
                        }
                    }
                }
            }
        }
        WindowEvent::DragDrop(DragDropEvent::Drop { paths, position }) => {
            if let Some(id) = note_id_from_label(window.label()) {
                image_drop::on_drop(window, id, paths, *position);
            }
        }
        WindowEvent::Destroyed => {
            // A note kept open at the last lock no longer has an editor that
            // could save it: lock it now (design §4.3).
            if let Some(id) = note_id_from_label(window.label()) {
                crate::privacy::release_kept_open(window.app_handle(), id);
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_note_settings_window_is_not_taken_for_a_note() {
        assert_eq!(note_id_from_label(NOTE_SETTINGS), None);
        assert_eq!(note_id_from_label(&note_label("abc")), Some("abc"));
    }

    #[test]
    fn a_window_is_centred_in_an_area_at_any_offset() {
        let area = Rect::new(1920.0, 27.0, 1920.0, 1053.0);
        assert_eq!(centred_in(&area, 300.0, 280.0), (2730.0, 413.5));
        let origin = Rect::new(0.0, 0.0, 1280.0, 800.0);
        assert_eq!(centred_in(&origin, 300.0, 280.0), (490.0, 260.0));
    }

    #[test]
    fn a_note_belongs_to_the_screen_it_mostly_overlaps() {
        let left = Rect::new(0.0, 0.0, 1920.0, 1040.0);
        let right = Rect::new(1920.0, 0.0, 1280.0, 1000.0);
        let areas = [left, right];
        assert_eq!(
            best_area(&Rect::new(1800.0, 100.0, 300.0, 280.0), &areas),
            right
        );
        assert_eq!(
            best_area(&Rect::new(1700.0, 100.0, 300.0, 280.0), &areas),
            left
        );
        // Off every screen: the primary one.
        assert_eq!(
            best_area(&Rect::new(9000.0, 9000.0, 300.0, 280.0), &areas),
            left
        );
    }

    #[test]
    fn only_known_settings_sections_are_accepted() {
        for name in SETTINGS_SECTIONS {
            assert_eq!(settings_section(name), Some(name));
        }
        assert_eq!(settings_section("appearance"), Some("appearance"));
        for bad in [
            "",
            "Privacy",
            "Appearance",
            "appearance ",
            "privacy ",
            "privacy&x=1",
            "../privacy",
            "lock",
        ] {
            assert_eq!(settings_section(bad), None, "{bad:?}");
        }
    }

    #[test]
    fn the_manager_shows_at_startup_when_there_is_something_to_see() {
        assert!(manager_shown_at_startup(0, false, false), "no notes open");
        assert!(!manager_shown_at_startup(2, false, false), "notes only");
        assert!(manager_shown_at_startup(2, true, false), "errors to report");
        // `--reset-pin` ran while DeskNotes was closed: its notice must be seen
        // even when notes open (D11).
        assert!(manager_shown_at_startup(2, false, true), "PIN was reset");
        assert!(manager_shown_at_startup(0, false, true));
    }

    #[test]
    fn a_new_settings_window_loads_its_section_from_the_url() {
        assert_eq!(settings_url(None), "index.html");
        assert_eq!(settings_url(Some("privacy")), "index.html?section=privacy");
        assert_eq!(
            settings_url(settings_section("privacy-new-pin")),
            "index.html?section=privacy-new-pin"
        );
    }
}
