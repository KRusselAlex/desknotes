# Images in Notes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Paste, drop or insert PNG/JPEG/GIF/WebP images into notes. Images are re-encoded under 5 MB, stored in the database, shown through a local scheme, kept private while locked, and carried in backups.

**Architecture:**
- The core does three things:
  - prepares images in a pure module (decode, check, scale, re-encode);
  - stores them in two new tables (migration v8);
  - keeps `note_images` in step with note content, and carries images in backup v6.
- The shell adds three things:
  - two commands to add an image (raw bytes; file picker);
  - a `desknotes-image` URI scheme that applies the privacy lock;
  - a start-up clean-up.
- The editor gains an `image` node with resize handles, paste and drop handling, an Insert button and a message strip.

**Tech Stack:** Rust (`image` 0.25 with png/jpeg/gif/webp only, `sha2` 0.10, `base64` 0.22), Tauri 2 (`register_asynchronous_uri_scheme_protocol`, `tauri::ipc::Request` raw body, dialog plugin), Tiptap 3.32.2, React 19, Vitest.

**Spec:** `docs/superpowers/specs/2026-11-06-images-in-notes-design.md`

## Global Constraints

- **Branch `feat/images-in-notes`.**
  - Conventional Commits with the footer `Refs: DES-23` and one `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` line.
  - Never stage `.superpowers/`.
- **Project rules:**
  - All SQL in `crates/desknotes-core`.
  - Only `src/ipc` calls `invoke` or builds image URLs.
  - Validate in Rust.
  - Content is validated Tiptap JSON.
  - Append migrations, never edit shipped ones.
  - Tokens, styles and icons come from `tokens.css` / `icons.ts`.
  - Platform code stays in `src-tauri/src/platform` and `src-tauri/src/windows`.
- **Limits, verbatim:**
  - Stored image ≤ **5 MB** (`5 * 1024 * 1024` bytes).
  - Input ≤ **40 MB** (`40 * 1024 * 1024`).
  - Longest side ≤ **2000 px** (larger images are scaled down).
  - Decode limit **100 megapixels**.
  - `MAX_BACKUP_BYTES` = **300 MiB**.
- **Types accepted:** PNG, JPEG, GIF, WebP, detected from bytes. Output rules:
  - JPEG → JPEG at quality 85.
  - PNG / WebP / still GIF → PNG.
  - A PNG result over 5 MB with no transparency → JPEG 85.
  - Animated GIF → GIF, frame by frame, not scaled.
  - No metadata is copied.
- **Image id:** 64 lowercase hex characters, the SHA-256 of the stored bytes.
- **Node:** `{"type":"image","attrs":{"id":"<64 hex>","width":<10..100 integer or null>}}`. Block-level. No other attrs.
- **Copy, verbatim:**
  - Button: `Insert image…`
  - `That image is too large. Images can be up to 5 MB.`
  - `DeskNotes can add PNG, JPEG, GIF or WebP images.`
  - `That image could not be added.`
  - Placeholder: `Image not found`
  - Export refusal: `This backup would be over 300 MB. Remove some images and try again.`
- **Message strip:** `.dn-save-error` look with the `alert` icon and a close ×. It closes itself after 8 s.
- **Clean-up** of unused images happens only at start-up, never during a session.
- **New dependencies are justified in the PR** (licence MIT/Apache/ISC, need, platforms).
- **Gate before every commit:**
  - `npm test && npm run lint && npm run typecheck`
  - `cargo test --workspace`
  - `cargo clippy --workspace --all-targets -- -D warnings`
  - `cargo fmt --all --check`

## Review Focus

1. **The lock leaks through the scheme.** While locked, an image referenced only by private notes is not served, but one also used by a readable note is. Owner: Task 2, `image_for_display_respects_the_lock`.
2. **A mid-session purge breaks Ctrl+Z.** Removing an image from note A and purging note B must not delete the image row. Owner: Task 2, `purge_never_deletes_images`.
3. **A web `<img>` sneaks in through an HTML paste.** Pasting `<p>x</p><img src="https://example.com/a.png">` gives no image node. Owner: Task 5, `html_paste_drops_foreign_images`.
4. **A backup of a note with a missing image cannot be restored.** It must restore, and the note keeps its node. Owner: Task 3, `restore_keeps_a_note_whose_image_is_missing`.
5. **A tiny file claiming 50 000 × 50 000 pixels freezes the app.** It is refused as too large without allocating. Owner: Task 1, `huge_dimensions_are_refused_without_decoding`.

---

### Task 1: Core — image preparation (pure, no SQL)

**Files:**
- Create `crates/desknotes-core/src/image_prep.rs` and register it in `lib.rs`.
- Modify `crates/desknotes-core/Cargo.toml` and the workspace `Cargo.toml`: `image = { version = "0.25", default-features = false, features = ["png", "jpeg", "gif", "webp"] }`, `sha2 = "0.10"`.
- Modify `crates/desknotes-core/src/error.rs`.

**Interfaces (produced):**
- `pub struct PrepLimits { pub max_input: usize, pub max_output: usize, pub max_side: u32, pub max_pixels: u64 }`, with `PrepLimits::DEFAULT` set to the Global values.
- `pub struct PreparedImage { pub id: String, pub mime: &'static str, pub width: u32, pub height: u32, pub bytes: Vec<u8> }`.
  - `mime` is one of `image/png`, `image/jpeg`, `image/gif`.
- `pub fn prepare_image(input: &[u8]) -> CoreResult<PreparedImage>` calls `prepare_image_with(input, &PrepLimits::DEFAULT)`.
- `pub fn image_id(bytes: &[u8]) -> String` returns the lowercase hex SHA-256.
- `pub fn sniff_mime(bytes: &[u8]) -> Option<&'static str>` returns png, jpeg, gif or webp (as `image/webp`), else `None`.
- `CoreError::Image(ImageError)` with `pub enum ImageError { TooLarge, Unsupported, Unreadable }`. Its `code()` values are `image_too_large`, `image_unsupported` and `image_unreadable`.

**Steps:**
- [ ] **Write failing tests** in `image_prep.rs`. Build the inputs in the test with the `image` crate.
  - `png_keeps_size_and_becomes_png`: a 300×200 RGBA PNG gives `mime == "image/png"`, 300×200, and `id == image_id(&bytes)`.
  - `large_photo_is_scaled_to_2000`: a 4000×3000 RGB JPEG gives `image/jpeg`, 2000×1500.
  - `exif_and_gps_are_removed`:
    - insert an APP1 `Exif\0\0` segment containing the ASCII `GPS` right after the SOI marker of a JPEG;
    - the output contains neither `b"Exif"` nor `b"GPS"`.
  - `webp_becomes_png`: a WebP produced with `image`'s lossless encoder gives `image/png`.
  - `animated_gif_keeps_its_frames`: a 2-frame 40×40 GIF gives `image/gif`, and decoding the output yields 2 frames.
  - `svg_and_pdf_are_unsupported`:
    - `b"<svg xmlns=…>"` gives `Unsupported`;
    - `b"%PDF-1.7…"` gives `Unsupported`;
    - an empty slice gives `Unsupported`.
  - `damaged_png_is_unreadable`: a valid PNG cut in half gives `Unreadable`.
  - `input_over_limit_is_too_large`: input over `max_input` (test limits of 1 KB) gives `TooLarge` before decoding.
  - `still_too_large_after_shrinking`: a 1000×1000 random-noise PNG with `max_output` 50 KB gives `TooLarge`.
  - `huge_dimensions_are_refused_without_decoding`: a valid PNG header declaring 50 000 × 50 000 (IHDR only, with a correct CRC) gives `TooLarge`.
- [ ] **Run** `cargo test -p desknotes-core image_prep`. Expect FAIL.
- [ ] **Implement.**
  - Use `ImageReader::with_format` plus `image::Limits` (`max_image_width`/`height` and `max_alloc` derived from `max_pixels`) so oversize dimensions fail before allocation; map that limit error to `TooLarge`.
  - Scale with `resize` using `FilterType::Lanczos3`.
  - Detect transparency from the colour type, and from any alpha < 255 when one is present.
- [ ] **Run** the tests and the gate. Expect PASS.
- [ ] **Commit:** `feat(core): prepare images — check, scale, strip metadata`.

### Task 2: Core — storage, content rule, references, lock

**Files:**
- `crates/desknotes-core/src/db/migrations.rs`: append v8.
- New `crates/desknotes-core/src/db/images.rs`.
- `db/notes.rs`: `save_content`, `insert_note_in` and `purge_note` (the last unchanged, but tested).
- `validation.rs`.
- `tests/fixtures/rich-doc.json`. If a TS test that loads this fixture fails only because the editor has no image node yet, mark that assertion `it.todo` and point it at Task 5. Task 5 restores it.

**Interfaces:**
- **Consumes:** `prepare_image`, `PreparedImage` and `CoreError::Image` from Task 1.
- **Produces:**
  - Migration v8:
    - `CREATE TABLE images (id TEXT PRIMARY KEY NOT NULL, mime TEXT NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL, bytes BLOB NOT NULL, created_at INTEGER NOT NULL);`
    - `CREATE TABLE note_images (note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE, image_id TEXT NOT NULL REFERENCES images(id), PRIMARY KEY (note_id, image_id));`
    - `CREATE INDEX note_images_image ON note_images(image_id);`
  - `#[derive(Serialize)] #[serde(rename_all = "camelCase")] pub struct ImageInfo { pub id: String, pub width: u32, pub height: u32 }`.
  - `Database::add_image(&self, note_id: &str, input: &[u8]) -> CoreResult<ImageInfo>`:
    - refuses a locked note (`refuse_if_note_locked`), an edit-locked note (`NotAllowed`) and a missing note (`NotFound`);
    - prepares the image, then `INSERT OR IGNORE`;
    - does **not** touch `note_images`, because the reference appears when the note saves.
  - `Database::image_for_display(&self, id: &str) -> CoreResult<Option<(String, Vec<u8>)>>` returns `(mime, bytes)`. It gives `None` when the id is malformed or unknown, or when the lock is active and no referencing note is readable (readable = what `refuse_if_note_locked` allows).
  - `pub(super) fn sync_note_images_in(tx: &Transaction, note_id: &str, doc: &Value) -> CoreResult<()>`: delete the note's rows, then insert one row per distinct image id in `doc` **that exists in `images`**.
  - `Database::remove_unused_images(&self) -> CoreResult<usize>` deletes images with no `note_images` row.
  - `validation::image_ids(doc: &Value) -> Vec<String>`: distinct ids in document order.

**Steps:**
- [ ] **Write failing tests** in `db/images.rs` unless noted. Use small PNGs built in the test.
  - `add_image_stores_once`: adding the same PNG twice gives the same id and one row.
  - `add_image_refuses_locked_edit_locked_and_missing_notes`.
  - `save_content_records_references`:
    - save content with the image node gives one `note_images` row;
    - saving again without it gives zero rows, but the `images` row is still there.
  - `unknown_image_id_is_saved_not_refused`: content with a well-formed id not in `images` saves OK, with zero `note_images` rows.
  - `duplicate_shares_images`: a duplicate has its own row pointing at the same image id.
  - `purge_never_deletes_images`:
    - remove the image from A and save;
    - purge trashed note B;
    - `image_for_display(id)` is still `Some`.
  - `remove_unused_images_keeps_trashed_and_archived`: images of trashed and archived notes stay, and only the unreferenced one is removed (count 1).
  - `image_for_display_respects_the_lock`:
    - with a PIN set and locked, an image used only by a private note gives `None`;
    - after it is also used by a non-private note, it gives `Some`;
    - unlocked, it gives `Some`;
    - `"../x"` and an uppercase id give `None`.
  - `validation.rs`:
    - `image_node_rules`: the id must be 64 lowercase hex; `width` must be an integer 10–100 or null; any other attr is refused; the node is allowed only as a child of `doc`, `listItem`, `taskItem` or `blockquote` (refused inside `paragraph` or `heading`).
    - `images_add_no_text`: title and search text are unchanged by an image node.
  - Extend `rich-doc.json` with one image node, using id `"a" × 64` and width 50, so the existing fixture tests (Rust and TS) exercise it.
  - **Migration:** the v0.2.0 fixture upgrade test now reaches version 8 with the pre-migration copy present.
- [ ] **Run** and expect FAIL.
- [ ] **Implement.**
  - `save_content` runs in one `unchecked_transaction()` with `sync_note_images_in`.
  - `insert_note_in` calls the sync, so duplicate, welcome and restore get it.
- [ ] **Run** and expect PASS, then the gate.
- [ ] **Commit:** `feat(core): store images and track which notes use them`.

### Task 3: Core — backup version 6

**Files:**
- `crates/desknotes-core/src/backup.rs` and `db/backup.rs`.
- `docs/backup-format.md`.
- Add the dependency `base64 = "0.22"`.

**Interfaces:**
- **Consumes:** `images` / `note_images`, `image_id` and `sniff_mime` from Tasks 1–2.
- **Produces:**
  - `BACKUP_VERSION = 6`.
  - `MAX_BACKUP_BYTES = 300 * 1024 * 1024`.
  - `Backup` gains `#[serde(default)] pub images: Vec<BackupImage>`, where `pub struct BackupImage { pub id: String, pub mime: String, pub width: u32, pub height: u32, pub data: String }` and `data` is standard base64.
  - `export_backup` returns `CoreError::NotAllowed("This backup would be over 300 MB. Remove some images and try again.")` when the serialised file would exceed the limit.

**Steps:**
- [ ] **Write failing tests** in `db/backup.rs`:
  - `version_6_round_trip_keeps_images`:
    - export (note with image, plus a trashed note with another image);
    - restore into a fresh DB;
    - both images come back byte-identical and are served by `image_for_display`.
  - `export_includes_only_referenced_images`: an unreferenced row is not exported.
  - `restore_keeps_a_note_whose_image_is_missing`: a v6 file whose note references an id absent from `images` restores, and the note's content still has the node.
  - `bad_image_refuses_the_whole_file`, refused with `Validation` and nothing changed, for each of:
    - an id that doesn't match the SHA-256;
    - a mime that isn't png/jpeg/gif/webp;
    - `sniff_mime` disagreeing with the mime;
    - decoded size over 5 MB;
    - invalid base64.
  - `version_5_file_still_restores`, with no `images` key.
  - `export_over_limit_is_refused`: test through a `pub(crate)` limit parameter rather than 300 MiB of data.
- [ ] **Run** and expect FAIL.
- [ ] **Implement.** Restore inserts the images (`INSERT OR IGNORE`) before the notes, in the same transaction.
- [ ] **Run** and expect PASS, then the gate.
- [ ] **Update** `docs/backup-format.md`: a version 6 section, the `images` example and the versions table.
- [ ] **Commit:** `feat(core): backup format 6 carries images`.

### Task 4: Shell — commands, image scheme, start-up clean-up

**Files:**
- New `src-tauri/src/commands/images.rs`.
- `commands/mod.rs`, `lib.rs` (registration and scheme), `state.rs` (clean-up).
- `src-tauri/tauri.conf.json` (CSP).
- `src-tauri/src/windows/mod.rs` (note window builder).
- `src/ipc/commands.ts`, `src/types/note.ts`, `src/dev/preview.tsx`.

**Interfaces:**
- **Consumes:** `Database::add_image`, `image_for_display`, `remove_unused_images` and `ImageInfo` (Task 2).
- **Produces:**
  - `#[tauri::command] add_image(state, request: tauri::ipc::Request<'_>) -> IpcResult<ImageInfo>`:
    - the body must be `InvokeBody::Raw`, else a validation error;
    - the header `note-id` is checked with `parse_note_id`.
  - `#[tauri::command] pick_image(app, state, note_id: String) -> IpcResult<Option<ImageInfo>>`:
    - the dialog title is `Insert image`;
    - the filter is `"Images", ["png","jpg","jpeg","gif","webp"]`;
    - a file whose metadata length is over 40 MB gives `image_too_large` without being read.
  - The scheme `desknotes-image`:
    - path `/<id>`, answered from `image_for_display`;
    - `200` with `Content-Type` and `Cache-Control: no-store`, else `404` with an empty body;
    - runs off the main thread.
  - In TS:
    - `commands.addImage(noteId: string, bytes: Uint8Array): Promise<ImageInfo>` passes the bytes as the raw body and `headers: { "note-id": noteId }`;
    - `commands.pickImage(noteId: string): Promise<ImageInfo | null>`;
    - `imageUrl(id: string): string` in `src/ipc/images.ts` uses `convertFileSrc(id, "desknotes-image")`.
  - CSP: `img-src 'self' data: desknotes-image:`. Nothing else changes. (Ruling during the build: the Windows-only `http://desknotes-image.localhost` form is left to the Windows port.)
  - Start-up: right after `Database::open` succeeds in `AppState::open`, call `remove_unused_images`. Log the count on success, and only log on error.
  - Note windows: `.disable_drag_drop_handler()` so the webview receives HTML5 file drops (Task 5).

**Steps:**
- [ ] **Write failing tests:**
  - **Rust**, a pure helper `image_response(found: Option<(String, Vec<u8>)>) -> http::Response<Vec<u8>>`: status, headers and an empty 404 body.
  - **Rust:** `scheme_path_to_id` accepts `/` + 64 hex only, and refuses `/x/../y`, query strings and uppercase.
  - **TS** (`commands.test.ts` style):
    - `addImage` invokes `add_image` with a `Uint8Array` body and the `note-id` header;
    - `pickImage` invokes `pick_image` with `{ noteId }`;
    - `imageUrl` returns the `convertFileSrc` result (mocked).
  - A test asserting the CSP string in `tauri.conf.json` contains the new `img-src` and no `http:`/`https:` scheme sources.
- [ ] **Run** and expect FAIL.
- [ ] **Implement.** Add preview mocks: `addImage` returns a fixed `ImageInfo`; `imageUrl` returns a data URL of a small PNG.
- [ ] **Run** and expect PASS, then the gate.
- [ ] **Commit:** `feat: image commands, desknotes-image scheme and start-up clean-up`.

### Task 5: Editor — image node, resize, paste/drop, Insert button, messages

**Files:**
- New `src/features/notes/imageNode.ts`, plus a node view in the same file or `ImageView.tsx`.
- New `src/features/notes/imageInput.ts`: file checks plus the insert helper.
- New `src/features/notes/ImageMessage.tsx`.
- `extensions.ts` (register; `sanitizeDoc` keeps image attrs by the Global rules).
- `NoteWindow.tsx` (`editorProps.handlePaste` / `handleDrop`, the message state).
- `FormatBar.tsx` (the button after Link).
- `src/components/icons.ts`: add `image`, the Lucide "image" path `<rect width="18" height="18" x="3" y="3" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.09-3.09a2 2 0 0 0-2.82 0L6 21"/>`.
- `src/styles/note.css`.
- Tests next to each file.

**Interfaces:**
- **Consumes:** `commands.addImage`, `commands.pickImage`, `imageUrl` and `ImageInfo` (Task 4). Error codes `image_too_large`, `image_unsupported`, `image_unreadable` (Task 1); any other code is shown as the "could not be added" message.
- **Produces:** `type ImageProblem = "too_large" | "unsupported" | "failed"` and `imageProblemText(p): string`, which returns the three Global messages.

**Behaviour:**
- **The node** is block, atom and selectable.
  - `renderHTML` gives `<img src={imageUrl(id)} data-image-id={id} style="width:{w}%">`.
  - `parseHTML` accepts an `img` only when `data-image-id` is 64-hex, or when `src` is a DeskNotes image URL from which the id can be recovered. Every other `img` is dropped.
- **The node view:**
  - shows the image at its width with `--dn-radius-sm` corners;
  - when selected, shows a `--dn-focus` 2 px outline and four corner handles;
  - while dragging a handle, sets the width to a percentage of the editor's content width, clamped to 10–100 and rounded to an integer, and commits it once on pointer-up (one undo step);
  - when the image fails to load, shows a muted box reading `Image not found`.
- **Paste:** use image files from `clipboardData.files` only when the clipboard HTML is empty or holds nothing but `<img>` elements (`shouldPasteFiles`); insert at the paste point, mapped through edits made during the upload. Otherwise let ProseMirror paste the HTML, so `parseHTML` filtering applies. (Ruling during the build: replaces "pixels win over HTML".)
- **Drop:** take image files from `dataTransfer.files` and insert them at `view.posAtCoords`.
- **Before sending:**
  - `file.size > 40 MB` gives `too_large`;
  - a `file.type` that isn't png/jpeg/gif/webp gives `unsupported`;
  - Rust checks again.
- **Insert image… button:** in the format bar after Link (label and title `Insert image…`, icon `image`). It calls `pickImage`, and inserts the image at the selection when the result isn't null.
- **ImageMessage:**
  - `role="alert"`, using the `dn-save-error` look;
  - shows the `alert` icon, the text and a close button `aria-label="Dismiss"`;
  - closes itself after 8000 ms;
  - a new problem replaces the old one.
- **High contrast:** the image and its handles follow the existing `.is-high-contrast` rules (outline uses `--dn-hc-line`).

**Steps:**
- [ ] **Write failing tests:**
  - `imageNode.test.ts`:
    - `round_trips_through_json`: an `{id, width: 50}` node serialises to exactly that.
    - `html_paste_drops_foreign_images`: `<p>x</p><img src="https://example.com/a.png">` gives a doc with no image node.
    - `html_paste_keeps_own_images`: `<img data-image-id="<64 hex>">` gives one image node.
    - `sanitize_clamps_bad_width`: `width: 500` and `width: "x"` give null.
  - `imageInput.test.ts`:
    - a 41 MB `File` gives `too_large` and `addImage` is not called;
    - `image/svg+xml` gives `unsupported`;
    - an `image/png` file calls `addImage(noteId, bytes)` and inserts a node with the returned id;
    - a rejected `addImage` with code `image_too_large` gives `too_large`, and code `io` gives `failed`.
  - `ImageMessage.test.tsx`:
    - the three texts appear verbatim;
    - with fake timers, it is gone after 8000 ms;
    - Dismiss closes it.
  - `FormatBar.test.tsx`:
    - the `Insert image…` button exists after Link;
    - clicking it calls `pickImage`;
    - a `null` result inserts nothing.
  - `NoteWindow.test.tsx`: pasting a `ClipboardEvent` that carries a PNG file and HTML inserts one image node and calls `addImage` once.
- [ ] **Run** and expect FAIL.
- [ ] **Implement.**
- [ ] **Run** and expect PASS, then the gate.
- [ ] **Check the preview** at `http://localhost:1420/preview.html?w=note` (or the existing note preview route) in light, dark and high contrast at 300 × 280:
  - an image at full width and at 50 %;
  - the handles when selected;
  - the message strip;
  - the Image-not-found box.
- [ ] **Commit:** `feat(notes): images in the editor — paste, drop, insert, resize`.

### Task 6: Real-app check, docs (controller)

**Steps:**
- [ ] **Release build.** Run it isolated (Xvfb, a private D-Bus and a scratch `HOME`) and check:
  - paste a PNG through `xclip -selection clipboard -t image/png` with focus in the note (if focus can't be given on bare Xvfb, record it as an owner check);
  - Insert image with a JPEG through the picker;
  - restart: the image is still there, with its width;
  - a 12 MB phone-size JPEG with EXIF GPS (generated) is stored ≤ 5 MB and ≤ 2000 px, and has no `Exif` in the stored blob (read-only sqlite);
  - an SVG and a renamed PDF are refused with the right message;
  - lock the app: `curl` cannot reach the scheme, so check through the core test plus a webview fetch from the manager's console in the dev build (record which);
  - export, restore into a fresh folder: images are back;
  - v0.2.0 fixture → v8 upgrade with its pre-migration copy.
- [ ] **Owner checks** (installed .deb): drag a photo from Files onto a note, and Ctrl+V of a screenshot from GNOME's screenshot tool.
- [ ] **Record** in `docs/testing/m3-images-verification.md`.
  - Add a CHANGELOG Unreleased entry.
  - Add the new crates to `THIRD_PARTY_NOTICES.md` only if their licences require notice in the binary (MIT/Apache do: list `image`, `sha2`, `base64` and the image codec crates `cargo tree -p desknotes-core -e normal` shows, with their licences).
- [ ] **Commit:** `docs: images in notes verification`.
