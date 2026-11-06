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

/// The image's bytes from an `add_image` body, at most the input limit.
pub fn body_bytes(body: &InvokeBody) -> IpcResult<Vec<u8>> {
    body_bytes_within(body, PrepLimits::DEFAULT.max_input)
}

/// Normally the body is raw binary. Once a window's custom-protocol IPC has failed,
/// Tauri sends every call through postMessage for the life of that window, and the
/// `Uint8Array` then arrives as a JSON array of numbers; that is accepted too, as long
/// as every element is a whole number from 0 to 255. The length is checked first, so
/// an over-long array is refused before anything is converted.
fn body_bytes_within(body: &InvokeBody, max: usize) -> IpcResult<Vec<u8>> {
    let not_bytes = || IpcError::new("validation", "the image must be sent as bytes");
    match body {
        InvokeBody::Raw(bytes) if bytes.len() > max => Err(too_large()),
        InvokeBody::Raw(bytes) => Ok(bytes.clone()),
        InvokeBody::Json(serde_json::Value::Array(items)) => {
            if items.len() > max {
                return Err(too_large());
            }
            items
                .iter()
                .map(|v| v.as_u64().and_then(|n| u8::try_from(n).ok()))
                .collect::<Option<Vec<u8>>>()
                .ok_or_else(not_bytes)
        }
        InvokeBody::Json(_) => Err(not_bytes()),
    }
}

/// The note named by the `note-id` header, in canonical form.
pub fn note_id_from_headers(headers: &http::HeaderMap) -> IpcResult<String> {
    let raw = headers
        .get("note-id")
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| IpcError::new("validation", "the note id is missing"))?;
    Ok(parse_note_id(raw)?)
}

/// Add an image to a note. The body is the file's bytes (see `body_bytes`) and the
/// `note-id` header names the note. Returns what the editor needs to place it.
#[tauri::command]
pub async fn add_image(state: State<'_, AppState>, request: Request<'_>) -> IpcResult<ImageInfo> {
    let note_id = note_id_from_headers(request.headers())?;
    let bytes = body_bytes(request.body())?;
    // A refusal for the note comes first and quickly; it is checked again when storing.
    state.with_db(|db| db.check_note_accepts_images(&note_id))?;
    let prepared = prepare(bytes).await?;
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

    use serde_json::json;

    fn code_of<T: std::fmt::Debug>(r: IpcResult<T>) -> String {
        r.expect_err("expected a refusal").code
    }

    #[test]
    fn raw_body_bytes_pass_through() {
        let body = InvokeBody::Raw(vec![0x89, b'P', b'N', b'G']);
        assert_eq!(body_bytes(&body).unwrap(), vec![0x89, b'P', b'N', b'G']);
    }

    #[test]
    fn json_array_of_bytes_is_accepted_after_the_postmessage_fallback() {
        let body = InvokeBody::Json(json!([0, 1, 127, 255]));
        assert_eq!(body_bytes(&body).unwrap(), vec![0, 1, 127, 255]);
        assert_eq!(
            body_bytes(&InvokeBody::Json(json!([]))).unwrap(),
            Vec::<u8>::new()
        );
    }

    #[test]
    fn json_array_with_anything_but_bytes_is_refused() {
        for bad in [
            json!([1, 256]),
            json!([1, -1]),
            json!([1, "2"]),
            json!([1, 2.5]),
            json!([1, 1.0]),
            json!([1, null]),
            json!([[1]]),
        ] {
            assert_eq!(
                code_of(body_bytes(&InvokeBody::Json(bad.clone()))),
                "validation",
                "{bad}"
            );
        }
    }

    #[test]
    fn other_json_bodies_are_refused() {
        for bad in [
            json!({"bytes": [1, 2]}),
            json!("iVBORw0KGgo="),
            json!(null),
            json!(7),
        ] {
            assert_eq!(code_of(body_bytes(&InvokeBody::Json(bad))), "validation");
        }
    }

    #[test]
    fn bodies_over_the_limit_are_too_large() {
        let too_large = CoreError::Image(ImageError::TooLarge).code();
        let array = InvokeBody::Json(json!([1, 2, 3, 4, 5]));
        assert_eq!(code_of(body_bytes_within(&array, 4)), too_large);
        assert_eq!(body_bytes_within(&array, 5).unwrap(), vec![1, 2, 3, 4, 5]);
        // The length is checked before any element, so a long array is refused even
        // when its elements are not bytes.
        let junk = InvokeBody::Json(json!(["x", "x", "x", "x", "x"]));
        assert_eq!(code_of(body_bytes_within(&junk, 4)), too_large);
        let raw = InvokeBody::Raw(vec![0; 5]);
        assert_eq!(code_of(body_bytes_within(&raw, 4)), too_large);
    }

    fn headers(value: Option<&[u8]>) -> http::HeaderMap {
        let mut map = http::HeaderMap::new();
        if let Some(v) = value {
            map.insert("note-id", http::HeaderValue::from_bytes(v).unwrap());
        }
        map
    }

    #[test]
    fn note_id_header_is_parsed() {
        let id = "0f8fad5b-d9cb-469f-a165-70867728950e";
        assert_eq!(
            note_id_from_headers(&headers(Some(id.as_bytes()))).unwrap(),
            id
        );
        assert_eq!(
            note_id_from_headers(&headers(Some(id.to_uppercase().as_bytes()))).unwrap(),
            id
        );
    }

    #[test]
    fn missing_or_bad_note_id_header_is_refused() {
        assert_eq!(code_of(note_id_from_headers(&headers(None))), "validation");
        assert_eq!(
            code_of(note_id_from_headers(&headers(Some(b"not-a-uuid")))),
            "validation"
        );
        assert_eq!(
            code_of(note_id_from_headers(&headers(Some(b"")))),
            "validation"
        );
        // Not visible ASCII, so not readable as a string.
        assert_eq!(
            code_of(note_id_from_headers(&headers(Some(b"\xff\xfe")))),
            "validation"
        );
        assert_eq!(
            code_of(note_id_from_headers(&headers(Some(
                b"0f8fad5b-d9cb-469f-a165-70867728950e/../x"
            )))),
            "validation"
        );
    }

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
