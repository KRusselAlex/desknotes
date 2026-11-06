# Images in notes — design (DES-23)

Date: 2026-11-06 · Jira: DES-23 (parent DES-4, Milestone 3)
Source: DES-23 and the owner's answers on 2026-11-06 after mockups
(`.superpowers/brainstorm/…/images-in-notes.html`). Anything the owner did not decide is
marked **(my call)**.

## 1. Why and what success looks like
The owner wants images in notes. The common case is a screenshot kept in view (an error
message, a receipt, a map, a QR code), so pasting must be instant and safe. Success: paste
or drop an image and it appears in the note, stays after a restart, comes back from a
backup, and never makes the app contact a server or reveal a locked note.

**Anti-goals** (a failure even if it "works"):
- an image that loads anything from the internet, including an `<img src="https://…">`
  pasted from a page. (Image **pixels** on the clipboard, for example from a browser's
  "Copy Image", are fine: they are added like a screenshot and nothing is fetched. When
  the clipboard has both pixels and HTML, the pixels are used only if the HTML holds
  nothing but `<img>` elements; otherwise the HTML is pasted as text, so copying text or a
  table from Word or LibreOffice (which also put a picture of it on the clipboard) stays
  text **(my call, revised during the build)**.);
- a locked private note whose images can still be seen or fetched;
- a backup that silently leaves images out;
- a photo that keeps its GPS location.

## 2. How it behaves (owner-approved mockups)
1. **Adding.** Three ways, all ending in the same place:
   - **Paste** (Ctrl+V) an image from the clipboard;
   - **drop** an image file onto the note;
   - the new **Insert image** button in the format bar, after Link. It opens Ubuntu's
     file picker filtered to images (owner chose option A, the format bar).
   The image is inserted as its own block at the cursor, with text above and below.
2. **Showing.** The image takes the note's full width and keeps its shape. The note scrolls
   as usual. Rounded corners `--dn-radius-sm`.
3. **Resizing.** Click the image to select it: a terracotta (`--dn-focus`) outline and four
   corner handles. Dragging a corner makes it smaller or bigger, between 10 % and 100 %
   of the note's width (it never grows wider than the note). The size is saved as a
   percentage, so it follows the note when the note is resized. No crop, rotate or caption.
4. **Removing.** Backspace or Delete on a selected image removes it; Ctrl+Z brings it back.
5. **Messages.** A strip in the note's existing save-error style (`.dn-save-error` look,
   with the `alert` icon and a close ×), above the format bar. It closes on × or by
   itself after 8 s **(my call)**. Nothing is added to the note when it shows.
   - Too large: **"That image is too large. Images can be up to 5 MB."**
   - Wrong type: **"DeskNotes can add PNG, JPEG, GIF or WebP images."**
   - Anything else (unreadable or damaged file, disk error): **"That image could not be
     added."** **(my call)**
6. **Icon.** Lucide `image` (ISC, already credited in `THIRD_PARTY_NOTICES.md`) is added to
   `src/components/icons.ts`, the only new icon. Tooltip and accessible name:
   **"Insert image…"**.

## 3. Size rule (owner: images under 5 MB; shrinking is my recommendation, accepted)
- The owner's rule applies to what is **saved**: no stored image is over **5 MB**.
- Every image is decoded and re-encoded in Rust. While doing that, an image larger than
  **2000 px** on its longest side is scaled down to 2000 px **(my call)**. Smaller images
  keep their pixel size.
- Accepted input types: **PNG, JPEG, GIF, WebP**, detected from the file's bytes, not its
  name. SVG and everything else are refused.
- Input files over **40 MB** are refused before decoding, as a safety cap **(my call)**.
  Decoding also has a pixel limit (for example 100 megapixels) so a small file that
  claims a huge size cannot freeze the app **(my call)**.
- Output format **(my call; the builder may tune quality settings, not the rules)**:
  JPEG input → JPEG (quality about 85); PNG and WebP → PNG; if a PNG result is over 5 MB
  and has no transparency, it is saved as JPEG instead. Animated GIFs keep their animation
  and are re-encoded frame by frame without scaling; still GIFs are treated like PNG.
- After all this, a result still over 5 MB is refused with the "too large" message.
- Re-encoding drops all metadata (EXIF, GPS, comments, colour profiles are not copied).

## 4. Storage (owner decision 2026-11-06 — differs from the ticket)
The ticket proposed image files in an `attachments/` folder. The owner chose instead to store images
**inside the database** as blobs:
- The database is already copied before every migration and every restore
  (`VACUUM INTO`), so those safety copies include images with no extra code.
- Saving a note and its images can be one transaction; there are no half-written files.
- It keeps the rule "all data access lives in `desknotes-core`".

Schema: a new appended migration **v8**:
- `images(id TEXT PRIMARY KEY, mime TEXT, width INTEGER, height INTEGER, bytes BLOB,
  created_at INTEGER)`. `id` is the lowercase hex SHA-256 of the stored bytes, so the same
  image pasted twice is stored once.
- `note_images(note_id, image_id)`, primary key on both, `note_id` cascading with the note.
  It lists which notes reference which images and is rewritten from the note's content on
  every `save_content`, `duplicate_note`, `insert_note` and restore.

**Clean-up (my call).** An image no note references is deleted **only once, at start-up**,
before any window opens — never during a session. So Ctrl+Z after removing an image, or
pasting an image copied from a note that was purged since, always finds it in the same
session. A purged note's images therefore stay until the next start. Trashed and archived
notes keep their images.

**Safety copies.** The automatic copies made before a migration or a restore (`backups/`)
include the images, so each one is as large as the whole database. Nothing deletes old
copies today; pruning them is out of scope here (it would delete user data and needs its
own decision).

## 5. In the note's content
- A new node `image`, block-level, with exactly two attrs:
  - `id`: 64 lowercase hex characters (required);
  - `width`: integer percent 10–100, or null (= 100).
- It is added to `ALLOWED_NODES` in `crates/desknotes-core/src/validation.rs` with these
  attr rules, and to the shared fixture `tests/fixtures/rich-doc.json`. Saving a note whose
  image `id` is not in `images` is **not** refused **(my call)**: a save must never be
  lost over an image. `note_images` records only ids that exist; the editor shows a
  missing image as a small muted "Image not found" box the user can delete. In practice
  this only happens to a hand-edited database or an image copied before a restart whose
  note was purged.
- The node never stores a URL. The editor builds the display address from the id
  (see §6). When HTML is pasted (from a web page, say), an `<img>` is kept only if it is
  one of DeskNotes' own image addresses; every other `<img>` is dropped **(my call)**. So
  copying an image from one note and pasting it into another works, and web images never
  get in.
- Images add nothing to the note's title, search text or snippet. A note with only an
  image gets the usual empty-note title.
- Duplicating a note shares its images (same ids).

## 6. Getting bytes in and out
- **In.**
  - Paste and drop send the file's bytes to one Rust command (for example
    `add_image(note_id, bytes)`) that validates, re-encodes, stores and returns
    `{ id, width, height }`. Raw binary IPC, not base64 **(my call)**.
  - The Insert button calls a command that opens the file picker in Rust (as
    backup export/restore already do with the dialog plugin) and then follows the same
    path, so no file path or bytes cross the webview.
  - Drop: Tauri may intercept file drops on the window; the builder checks whether the
    webview's drop event or Tauri's drag-drop event (file paths, read in Rust) works in our
    window setup, and uses the one that does.
  - Adding is refused for a locked note and for an edit-locked note (as typing is).
- **Out.** A custom URI scheme registered in the shell, `desknotes-image://…/<id>` **(my
  call for the name)**, answers with the stored bytes and their MIME type.
  - It accepts only a 64-hex id and nothing else (no paths).
  - **Privacy:** while the privacy lock is on, it refuses any image that is referenced only
    by private notes. Locked notes already show an empty document, so no id leaks
    through content.
  - The CSP gains only that scheme in `img-src`; no `http`/`https` is added.

## 7. Backups
- The JSON backup goes to **version 6**: a top-level `images` array of
  `{ id, mime, width, height, data }` with `data` in base64, holding every image any
  exported note references. `docs/backup-format.md` is updated.
- Restore checks each image the same way as a new one (type, size, the id matches the
  SHA-256 of the bytes) and refuses the whole file if one is bad, as it already does for
  bad notes. A note referencing an id missing from the file still restores and shows
  "Image not found" there, consistent with §5, so a backup of a note with a missing
  image can always be restored.
- Version 1–5 files still restore.
- `MAX_BACKUP_BYTES` rises from 200 MiB to **300 MiB** **(my call)**. Restore still reads
  the whole file in memory, so the limit stays modest (no streaming rewrite). That is
  roughly 1,000 typical screenshots, or about 45 images at the 5 MB maximum. Export refuses
  with a clear message if the file would be larger ("This backup would be over 300 MB.
  Remove some images and try again."), so the app never writes a backup it cannot read
  back.

## 8. Out of scope
Cropping, rotating, captions, alt text, image galleries, web image links, SVG, other files
(PDF etc.), showing images in the manager's list, and copying an image out to other apps
(the right-click "Copy image" of the webview may or may not work; it is not promised).

## 9. Dependencies (new)
- Rust: the `image` crate (MIT/Apache-2.0) with only the PNG, JPEG, GIF and WebP features;
  `sha2` (MIT/Apache-2.0, already in the lock through Tauri); `base64` (MIT/Apache-2.0)
  for backups.
- Web: `@tiptap/extension-image` 3.32.2 (MIT), matching the other Tiptap packages, or a
  small own node if its resizing does not fit.
- Each is justified in the PR as the template asks.

## 10. Acceptance
- Paste a screenshot, drop a PNG and use Insert image with a JPEG: each appears full width
  and stays after a restart.
- Resize to about half: the size stays after a restart and when the note is resized.
- A 12 MB phone photo is added, stored under 5 MB, at most 2000 px, with no EXIF/GPS left.
- An SVG, a PDF renamed `.png`, and a >40 MB file are refused with the right message and
  nothing is added.
- HTML paste of a web page with `<img src="https://…">`: no image node, no request.
- Lock the app: a private note's image cannot be fetched through the scheme.
- Delete an image, Ctrl+Z: it is back. Trash the note, purge it, restart: the image row is
  gone (unless another note uses it).
- Browser "Copy Image", then paste: the image is added; nothing is fetched.
- Export a backup with images, restore it on a fresh data folder: every image is back.
  A version 5 backup still restores.
- Database upgrade from the v0.2.0 fixture to v8 keeps all notes, with a pre-migration copy.
- Gate: `npm test && npm run lint && npm run typecheck`, `cargo test --workspace`,
  clippy `-D warnings`, `cargo fmt --check`. Real-app check recorded in `docs/testing/`.
