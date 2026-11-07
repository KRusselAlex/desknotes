//! Files dropped on a note window. Tauri's own drag-drop handler takes file drops (the
//! webview, WebKitGTK, gets no dropped files), so the files are read here and no path or
//! bytes cross the webview (images in notes, DES-23).

use std::path::PathBuf;

use desknotes_core::image_prep::PrepLimits;
use tauri::{Emitter, Manager, PhysicalPosition, Window};

use crate::commands::images::{
    Dropped, IMAGES_DROPPED, ImagesDropped, add_dropped_bytes, dropped_images, read_at_most,
    regular_file_len,
};
use crate::state::AppState;

/// Whether the drop point Tauri reports is in physical pixels. Tauri types it as
/// physical everywhere, but wry passes on the platform's own units: GTK widget
/// coordinates on Linux and points on macOS (both already CSS pixels at zoom 1), and
/// physical client pixels only on Windows (WebView2).
const DROP_POINT_IS_PHYSICAL: bool = cfg!(target_os = "windows");

/// The drop point in CSS pixels inside the webview. A scale that is not a positive
/// number counts as 1.
pub fn css_point(x: f64, y: f64, scale_factor: f64, physical: bool) -> (f64, f64) {
    let scale = if physical && scale_factor.is_finite() && scale_factor > 0.0 {
        scale_factor
    } else {
        1.0
    };
    (x / scale, y / scale)
}

/// Something dropped on the note `note_id`'s window: on a blocking thread (the event
/// loop never waits) the note is checked once, then each file is read, prepared and
/// stored; links are kept as text. The window then gets `images-dropped` with what was
/// added and the first problem. A drop of folders only says nothing.
pub fn on_drop(window: &Window, note_id: &str, paths: &[PathBuf], position: PhysicalPosition<f64>) {
    let (x, y) = css_point(
        position.x,
        position.y,
        window.scale_factor().unwrap_or(1.0),
        DROP_POINT_IS_PHYSICAL,
    );
    let app = window.app_handle().clone();
    let label = window.label().to_owned();
    let note_id = note_id.to_owned();
    let paths = paths.to_vec();
    tauri::async_runtime::spawn_blocking(move || {
        let Some(state) = app.try_state::<AppState>() else {
            return;
        };
        let max = PrepLimits::DEFAULT.max_input as u64;
        let dropped = dropped_images(
            &paths,
            max,
            || state.with_db(|db| db.check_note_accepts_images(&note_id)),
            regular_file_len,
            |path| read_at_most(path, max),
            |bytes| add_dropped_bytes(&state, &note_id, bytes),
        );
        if dropped == Dropped::default() {
            return;
        }
        let payload = ImagesDropped {
            note_id,
            images: dropped.images,
            texts: dropped.texts,
            problem: dropped.problem,
            x,
            y,
        };
        if let Err(e) = app.emit_to(label.as_str(), IMAGES_DROPPED, payload) {
            eprintln!("DeskNotes: could not send the dropped images to the note: {e}");
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_physical_drop_point_is_divided_by_the_scale() {
        assert_eq!(css_point(200.0, 90.0, 2.0, true), (100.0, 45.0));
        assert_eq!(css_point(150.0, 75.0, 1.5, true), (100.0, 50.0));
        assert_eq!(css_point(10.0, 20.0, 1.0, true), (10.0, 20.0));
    }

    #[test]
    fn a_drop_point_already_in_view_units_is_kept() {
        assert_eq!(css_point(200.0, 90.0, 2.0, false), (200.0, 90.0));
    }

    #[test]
    fn a_broken_scale_counts_as_one() {
        for bad in [0.0, -1.0, f64::NAN, f64::INFINITY] {
            assert_eq!(css_point(200.0, 90.0, bad, true), (200.0, 90.0), "{bad}");
        }
    }
}
