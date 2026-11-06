//! Images in notes: adding (paste, drop, picker) and the `desknotes-image` scheme
//! that serves them back to the webview (design: images in notes §6).

use std::fs;
use std::io::Read as _;
use std::path::{Path, PathBuf};

use desknotes_core::db::ImageInfo;
use desknotes_core::image_prep::{PrepLimits, PreparedImage, prepare_image};
use desknotes_core::validation::{is_image_id, parse_note_id};
use desknotes_core::{CoreError, ImageError};
use serde::Serialize;
use tauri::ipc::{InvokeBody, Request};
use tauri::{AppHandle, Manager, Runtime, State, UriSchemeContext, UriSchemeResponder, http};
use tauri_plugin_dialog::DialogExt as _;

use crate::error::{IpcError, IpcResult};
use crate::platform::clipboard::{ClipboardContent, clipboard_image};
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

/// What `paste_image` found on the clipboard.
#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum PastedImage {
    /// An image, now stored for the note.
    Image {
        image: ImageInfo,
    },
    /// No image but text, for the editor to paste as plain text.
    Text {
        text: String,
    },
    Nothing,
}

/// A paste the webview sees as empty: WebKitGTK gives the page no clipboard images, so
/// the clipboard is read here and no image bytes cross the webview. Without an image
/// the clipboard's text comes back, so an image-plus-text clipboard never loses it.
#[tauri::command]
pub async fn paste_image(
    app: AppHandle,
    state: State<'_, AppState>,
    note_id: String,
) -> IpcResult<PastedImage> {
    let note_id = parse_note_id(&note_id)?;
    let bytes = match clipboard_image(&app).await? {
        ClipboardContent::Image(bytes) => bytes,
        ClipboardContent::Text(text) => return Ok(PastedImage::Text { text }),
        ClipboardContent::Nothing => return Ok(PastedImage::Nothing),
    };
    if bytes.len() > PrepLimits::DEFAULT.max_input {
        return Err(too_large());
    }
    // As in `add_image`: the note first, the slow part off the database, then store.
    state.with_db(|db| db.check_note_accepts_images(&note_id))?;
    let prepared = prepare(bytes).await?;
    let image = state.with_db(|db| db.store_prepared_image(&note_id, &prepared))?;
    Ok(PastedImage::Image { image })
}

/// Sent to one note window after files were dropped on it: the images stored for the
/// note in drop order, the first refusal's code, and the drop point in CSS pixels.
pub const IMAGES_DROPPED: &str = "images-dropped";

#[derive(Debug, Clone, Serialize)]
pub struct ImagesDropped {
    pub images: Vec<ImageInfo>,
    pub problem: Option<String>,
    pub x: f64,
    pub y: f64,
}

fn read_error(e: std::io::Error) -> IpcError {
    IpcError::new("io", format!("The file could not be read: {e}"))
}

/// The length of a dropped path that is a regular file (links followed); `None` for a
/// folder or anything else, which a drop skips.
pub fn regular_file_len(path: &Path) -> IpcResult<Option<u64>> {
    let meta = fs::metadata(path).map_err(read_error)?;
    Ok(meta.is_file().then_some(meta.len()))
}

/// A file's bytes, reading at most one byte past `max`, so a file that grew after its
/// length was checked is still refused without being read whole.
pub fn read_at_most(path: &Path, max: u64) -> IpcResult<Vec<u8>> {
    let mut bytes = Vec::new();
    fs::File::open(path)
        .map_err(read_error)?
        .take(max.saturating_add(1))
        .read_to_end(&mut bytes)
        .map_err(read_error)?;
    if bytes.len() as u64 > max {
        return Err(too_large());
    }
    Ok(bytes)
}

/// Adds dropped files in order: folders and other non-files are skipped, a file over
/// `max` is refused from its length without being read, the rest are read and given to
/// `add` (check the note, prepare, store). Returns what was stored and the first
/// refusal's code; one bad file never stops the others.
pub fn dropped_images(
    paths: &[PathBuf],
    max: u64,
    mut file_len: impl FnMut(&Path) -> IpcResult<Option<u64>>,
    mut read: impl FnMut(&Path) -> IpcResult<Vec<u8>>,
    mut add: impl FnMut(Vec<u8>) -> IpcResult<ImageInfo>,
) -> (Vec<ImageInfo>, Option<String>) {
    let mut images = Vec::new();
    let mut problem = None;
    for path in paths {
        let mut one = || -> IpcResult<Option<ImageInfo>> {
            let Some(len) = file_len(path)? else {
                return Ok(None);
            };
            if len > max {
                return Err(too_large());
            }
            add(read(path)?).map(Some)
        };
        match one() {
            Ok(Some(image)) => images.push(image),
            Ok(None) => {}
            Err(e) => {
                problem.get_or_insert(e.code);
            }
        }
    }
    (images, problem)
}

/// Adds one dropped file's bytes to a note, as `add_image` does: the note checks, then
/// the slow part without the database lock, then storing (checked again). Blocking:
/// run it on a blocking thread.
pub fn add_dropped_bytes(state: &AppState, note_id: &str, bytes: Vec<u8>) -> IpcResult<ImageInfo> {
    state.with_db(|db| db.check_note_accepts_images(note_id))?;
    let prepared = prepare_image(&bytes)?;
    state.with_db(|db| db.store_prepared_image(note_id, &prepared))
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

    use std::path::{Path, PathBuf};

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

    fn info(id: &str) -> ImageInfo {
        ImageInfo {
            id: id.into(),
            width: 1,
            height: 1,
        }
    }

    /// Runs `dropped_images` over fake files: `files` maps a path to its length
    /// (`None` for a directory) and its bytes. Returns the result and the paths read.
    fn drop_fake(
        files: &[(&str, Option<u64>, &[u8])],
        max: u64,
        mut add: impl FnMut(Vec<u8>) -> IpcResult<ImageInfo>,
    ) -> ((Vec<ImageInfo>, Option<String>), Vec<String>) {
        let paths: Vec<PathBuf> = files.iter().map(|(p, _, _)| PathBuf::from(p)).collect();
        let find = |p: &Path| files.iter().find(|(n, _, _)| Path::new(n) == p).unwrap();
        let mut read = Vec::new();
        let result = dropped_images(
            &paths,
            max,
            |p| Ok(find(p).1),
            |p| {
                read.push(p.display().to_string());
                Ok(find(p).2.to_vec())
            },
            &mut add,
        );
        (result, read)
    }

    #[test]
    fn a_dropped_directory_is_skipped_without_a_problem() {
        let ((images, problem), read) = drop_fake(
            &[("/photos", None, b""), ("/a.png", Some(1), b"a")],
            10,
            |b| Ok(info(&String::from_utf8(b).unwrap())),
        );
        assert_eq!(images, vec![info("a")]);
        assert_eq!(problem, None);
        assert_eq!(read, vec!["/a.png"]);
    }

    #[test]
    fn a_dropped_file_over_the_limit_is_refused_without_reading_it() {
        let mut added = 0;
        let ((images, problem), read) = drop_fake(&[("/big.png", Some(11), b"x")], 10, |_| {
            added += 1;
            Ok(info("x"))
        });
        assert!(images.is_empty());
        assert_eq!(problem.as_deref(), Some("image_too_large"));
        assert!(read.is_empty(), "never read");
        assert_eq!(added, 0);
        // Exactly the limit is fine.
        let ((images, problem), _) = drop_fake(&[("/ok.png", Some(10), b"ok")], 10, |b| {
            Ok(info(&String::from_utf8(b).unwrap()))
        });
        assert_eq!((images, problem), (vec![info("ok")], None));
    }

    #[test]
    fn dropped_files_keep_their_order_and_the_first_problem_wins() {
        let files: &[(&str, Option<u64>, &[u8])] = &[
            ("/1.png", Some(1), b"1"),
            ("/doc.pdf", Some(3), b"pdf"),
            ("/2.png", Some(1), b"2"),
            ("/huge.png", Some(99), b""),
            ("/3.png", Some(1), b"3"),
        ];
        let ((images, problem), _) = drop_fake(files, 10, |b| {
            if b == b"pdf" {
                Err(CoreError::Image(ImageError::Unsupported).into())
            } else {
                Ok(info(&String::from_utf8(b).unwrap()))
            }
        });
        assert_eq!(images, vec![info("1"), info("2"), info("3")]);
        assert_eq!(problem.as_deref(), Some("image_unsupported"));
    }

    #[test]
    fn a_file_that_cannot_be_read_is_a_problem_and_the_rest_still_go_in() {
        let paths = vec![PathBuf::from("/gone.png"), PathBuf::from("/a.png")];
        let (images, problem) = dropped_images(
            &paths,
            10,
            |p| {
                if p == Path::new("/gone.png") {
                    Err(IpcError::new("io", "missing"))
                } else {
                    Ok(Some(1))
                }
            },
            |_| Ok(b"a".to_vec()),
            |_| Ok(info("a")),
        );
        assert_eq!(images, vec![info("a")]);
        assert_eq!(problem.as_deref(), Some("io"));
    }

    /// A fresh folder under the system temp folder, removed when dropped.
    struct TempDir(PathBuf);
    impl TempDir {
        fn new(name: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "desknotes-{name}-{}-{:?}",
                std::process::id(),
                std::thread::current().id()
            ));
            let _ = fs::remove_dir_all(&dir);
            fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn only_regular_files_have_a_length_to_drop() {
        let dir = TempDir::new("drop-len");
        let file = dir.0.join("a.png");
        fs::write(&file, b"12345").unwrap();
        assert_eq!(regular_file_len(&file).unwrap(), Some(5));
        assert_eq!(regular_file_len(&dir.0).unwrap(), None);
        assert_eq!(
            regular_file_len(&dir.0.join("missing.png"))
                .unwrap_err()
                .code,
            "io"
        );
    }

    #[test]
    fn reading_a_dropped_file_stops_after_the_limit() {
        let dir = TempDir::new("drop-read");
        let file = dir.0.join("a.png");
        fs::write(&file, b"12345").unwrap();
        assert_eq!(read_at_most(&file, 5).unwrap(), b"12345".to_vec());
        // Grown since its length was read: still refused.
        assert_eq!(code_of(read_at_most(&file, 4)), "image_too_large");
    }

    #[test]
    fn a_pasted_result_is_tagged_by_kind() {
        let image = serde_json::to_value(PastedImage::Image { image: info("a") }).unwrap();
        assert_eq!(
            image,
            json!({"kind": "image", "image": {"id": "a", "width": 1, "height": 1}})
        );
        let text = serde_json::to_value(PastedImage::Text { text: "hi".into() }).unwrap();
        assert_eq!(text, json!({"kind": "text", "text": "hi"}));
        assert_eq!(
            serde_json::to_value(PastedImage::Nothing).unwrap(),
            json!({"kind": "nothing"})
        );
    }

    #[test]
    fn the_dropped_payload_names_images_problem_and_point() {
        let payload = ImagesDropped {
            images: vec![info("a")],
            problem: Some("image_too_large".into()),
            x: 1.5,
            y: 2.0,
        };
        assert_eq!(
            serde_json::to_value(payload).unwrap(),
            json!({
                "images": [{"id": "a", "width": 1, "height": 1}],
                "problem": "image_too_large",
                "x": 1.5,
                "y": 2.0
            })
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
