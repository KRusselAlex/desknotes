//! Images in notes: adding (paste, drop, picker) and the `desknotes-image` scheme
//! that serves them back to the webview (design: images in notes §6).

use std::fs;

use desknotes_core::db::ImageInfo;
use desknotes_core::image_prep::{PrepLimits, PreparedImage, prepare_image};
use desknotes_core::validation::{is_image_id, parse_note_id};
use desknotes_core::{CoreError, ImageError};
use tauri::ipc::{InvokeBody, Request};
use tauri::{AppHandle, Manager, Runtime, State, UriSchemeContext, UriSchemeResponder, http};
use tauri_plugin_dialog::DialogExt as _;

use crate::error::{IpcError, IpcResult};
use crate::state::AppState;

/// The custom URI scheme the editor loads images from.
pub const SCHEME: &str = "desknotes-image";

/// The image id in a scheme request path: `/` and 64 lowercase hex characters, and
/// nothing else (no further segments, no query, no escapes).
pub fn scheme_path_to_id(path: &str) -> Option<&str> {
    path.strip_prefix('/').filter(|id| is_image_id(id))
}

/// The answer for one request: the bytes with their type, or an empty 404.
pub fn image_response(found: Option<(String, Vec<u8>)>) -> http::Response<Vec<u8>> {
    let builder = http::Response::builder()
        .header(http::header::CACHE_CONTROL, "no-store")
        .header("X-Content-Type-Options", "nosniff");
    let built = match found {
        Some((mime, bytes)) => builder
            .status(http::StatusCode::OK)
            .header(http::header::CONTENT_TYPE, mime)
            .body(bytes),
        None => builder.status(http::StatusCode::NOT_FOUND).body(Vec::new()),
    };
    // Only fails for an invalid header value; the stored type is one of four fixed ones.
    built.unwrap_or_else(|_| http::Response::new(Vec::new()))
}

/// Answer one `desknotes-image://…/<id>` request without blocking the main thread:
/// the database read happens on a blocking thread. Anything but a stored,
/// currently readable image is an empty 404.
pub fn handle_scheme<R: Runtime>(
    ctx: UriSchemeContext<'_, R>,
    request: http::Request<Vec<u8>>,
    responder: UriSchemeResponder,
) {
    let app = ctx.app_handle().clone();
    let target = request
        .uri()
        .path_and_query()
        .map(|p| p.as_str().to_owned())
        .unwrap_or_default();
    tauri::async_runtime::spawn_blocking(move || {
        let found = scheme_path_to_id(&target).and_then(|id| {
            let state = app.try_state::<AppState>()?;
            // The core applies the privacy lock; an error is answered like "not found".
            state.with_db(|db| db.image_for_display(id)).ok().flatten()
        });
        responder.respond(image_response(found));
    });
}

fn too_large() -> IpcError {
    CoreError::Image(ImageError::TooLarge).into()
}

/// Slow part of adding an image: check, scale and re-encode. Runs off the database.
async fn prepare(bytes: Vec<u8>) -> IpcResult<PreparedImage> {
    tauri::async_runtime::spawn_blocking(move || prepare_image(&bytes))
        .await
        .map_err(|e| IpcError::new("internal", e.to_string()))?
        .map_err(IpcError::from)
}

/// Add an image to a note. The body is the file's bytes (raw binary IPC) and the
/// `note-id` header names the note. Returns what the editor needs to place it.
#[tauri::command]
pub async fn add_image(state: State<'_, AppState>, request: Request<'_>) -> IpcResult<ImageInfo> {
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err(IpcError::new(
            "validation",
            "the image must be sent as raw bytes",
        ));
    };
    let note_id = request
        .headers()
        .get("note-id")
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| IpcError::new("validation", "the note id is missing"))?;
    let note_id = parse_note_id(note_id)?;
    if bytes.len() > PrepLimits::DEFAULT.max_input {
        return Err(too_large());
    }
    // A refusal for the note comes first and quickly; it is checked again when storing.
    state.with_db(|db| db.check_note_accepts_images(&note_id))?;
    let prepared = prepare(bytes.clone()).await?;
    state.with_db(|db| db.store_prepared_image(&note_id, &prepared))
}

/// "Insert image…": the file dialog opens here, so no path or bytes cross the
/// webview. `None` when the dialog is cancelled.
#[tauri::command]
pub async fn pick_image(
    app: AppHandle,
    state: State<'_, AppState>,
    note_id: String,
) -> IpcResult<Option<ImageInfo>> {
    let note_id = parse_note_id(&note_id)?;
    // Refuse before the dialog, not after (locked or missing note).
    state.with_db(|db| db.check_note_accepts_images(&note_id))?;
    let Some(chosen) = app
        .dialog()
        .file()
        .set_title("Insert image")
        .add_filter("Images", &["png", "jpg", "jpeg", "gif", "webp"])
        .blocking_pick_file()
    else {
        return Ok(None);
    };
    let path = chosen
        .into_path()
        .map_err(|e| IpcError::new("io", e.to_string()))?;
    let prepared = tauri::async_runtime::spawn_blocking(move || -> IpcResult<PreparedImage> {
        let len = fs::metadata(&path)
            .map_err(|e| IpcError::new("io", format!("The file could not be read: {e}")))?
            .len();
        if len > PrepLimits::DEFAULT.max_input as u64 {
            return Err(too_large());
        }
        let bytes = fs::read(&path)
            .map_err(|e| IpcError::new("io", format!("The file could not be read: {e}")))?;
        Ok(prepare_image(&bytes)?)
    })
    .await
    .map_err(|e| IpcError::new("internal", e.to_string()))??;
    state
        .with_db(|db| db.store_prepared_image(&note_id, &prepared))
        .map(Some)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn path_must_be_slash_and_64_lowercase_hex() {
        let id = "a".repeat(64);
        assert_eq!(scheme_path_to_id(&format!("/{id}")), Some(id.as_str()));
        let mixed = "0123456789abcdef".repeat(4);
        assert_eq!(
            scheme_path_to_id(&format!("/{mixed}")),
            Some(mixed.as_str())
        );
        assert_eq!(scheme_path_to_id(&id), None, "no leading slash");
        assert_eq!(scheme_path_to_id("/"), None);
        assert_eq!(scheme_path_to_id(""), None);
        assert_eq!(scheme_path_to_id("/x/../y"), None);
        assert_eq!(scheme_path_to_id(&format!("/{id}?x=1")), None);
        assert_eq!(scheme_path_to_id(&format!("/{id}/")), None);
        assert_eq!(scheme_path_to_id(&format!("//{id}")), None);
        assert_eq!(scheme_path_to_id(&format!("/{}", "A".repeat(64))), None);
        assert_eq!(scheme_path_to_id(&format!("/{}", "a".repeat(63))), None);
        assert_eq!(scheme_path_to_id(&format!("/{}", "a".repeat(65))), None);
        assert_eq!(scheme_path_to_id(&format!("/{}", "g".repeat(64))), None);
        assert_eq!(scheme_path_to_id(&format!("/{}%41", "a".repeat(62))), None);
    }

    #[test]
    fn found_image_answers_200_with_type_and_no_caching() {
        let res = image_response(Some(("image/png".into(), vec![1, 2, 3])));
        assert_eq!(res.status(), 200);
        assert_eq!(res.headers()["content-type"], "image/png");
        assert_eq!(res.headers()["cache-control"], "no-store");
        assert_eq!(res.body(), &vec![1, 2, 3]);
    }

    #[test]
    fn missing_image_answers_an_empty_404() {
        let res = image_response(None);
        assert_eq!(res.status(), 404);
        assert!(res.body().is_empty());
        assert_eq!(res.headers()["cache-control"], "no-store");
    }
}
