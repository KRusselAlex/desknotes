# Milestone 3 — images in notes: verification on Ubuntu

Date: 2026-11-06 · Branch: `feat/images-in-notes` (verified at fb911bc; I12 at d0b1d7b, after the final-review fixes) · Jira: DES-23
Design: `docs/superpowers/specs/2026-11-06-images-in-notes-design.md`

## Machine and conditions

| Item | Value |
|---|---|
| OS | Ubuntu 24.04.5 LTS, GNOME 46 on Wayland |
| Build | Release binary of this branch (`npm run tauri build -- --no-bundle`) |
| Isolation | **Hidden screen:** an `Xvfb` display, 1920 × 1080, with no window manager. **Private message bus:** a separate D-Bus daemon, so nothing talks to the owner's desktop. **Throwaway data:** a scratch `HOME` for each run, so `~/.local/share/io.github.krusselalex.desknotes/` was throwaway. The owner's DeskNotes kept running untouched. |
| Input | Clicks and keys with libxdo (XTEST). Keyboard focus was given with `xdo_focus_window`, since there is no window manager. |
| Files | Generated test files:<br>• an 800 × 500 PNG "screenshot";<br>• a 4000 × 3000 JPEG of 19.3 MB with an EXIF GPS block and a camera name (`TestCam`);<br>• an SVG containing a `<script>`;<br>• a PDF renamed `fake.png`. |
| Database | Read with Python `sqlite3` in read-only mode |

## Checked in the real app

| # | Check | Result |
|---|---|---|
| I1 | Format bar | It shows the new image button after Link (see the mockup). |
| I2 | Insert image… with the 19.3 MB photo, through the GTK file picker titled "Insert image" | The photo is stored as `image/jpeg`, **2000 × 1500**, **1.5 MB**. The stored bytes contain no `Exif` marker and no `TestCam`. It shows at full width with rounded corners. It is loaded through the `desknotes-image` scheme, with the CSP allowing only that scheme. The `note_images` row is written on save. |
| I3 | Insert image… with the PNG screenshot | Stored as `image/png`, 800 × 500 (not scaled), 13.8 KB. |
| I4 | Click the image, drag the bottom-right handle | The terracotta outline and four handles show. The width is saved as `51` in the note's content. |
| I5 | Restart | The image is still there, at 51 %. |
| I6 | Insert the renamed PDF, then the SVG | Each time the strip reads "DeskNotes can add PNG, JPEG, GIF or WebP images." It closes by itself after 8 s. No image row is added. |
| I7 | Select the image and press Delete, then Ctrl+Z | After Delete: `images` 1, `note_images` 0, so nothing is deleted during the session. After Ctrl+Z, the image is back (`note_images` 1). |
| I8 | Delete it again and restart | Start-up logs "removed 1 unused image(s)". `images` is 0. |
| I9 | Settings → Backup → Export backup… | The file has `"version": 6`, 1 note and an `images` entry (`image/png`, 800 × 500, base64). |
| I10 | Restore that file into a **fresh** data folder (Restore from backup… → "Replace notes") | The image comes back from the file, and `note_images` is 1. A `pre-restore-….db` copy is written first. After a restart the image is still there: the start-up clean-up keeps restored images. |
| I11 | Upgrade the v0.2.0 fixture (schema 3, 5 notes) | It reaches schema **8** with its 5 notes. `pre-migration-v3-….db` is written. |
| I12 | Insert image… with a generated animated GIF: 1280 × 720, 60 frames, 150.7 KB, with a GIF comment | Stored as `image/gif` at 147.3 KB. All 60 frames and the endless loop are kept, and the comment is gone. It shows in the note. |

## Checked on the owner's real desktop (2026-11-06, with the owner's agreement)

The first owner-desktop run used the installed .deb of 46d524c. It found that **pasting and dropping images did not work**. Temporary logging showed that WebKitGTK gives the page:
- **for a clipboard image:** an empty `clipboardData` (no types, no files);
- **for a dropped file:** no `File` (only `text/uri-list` with empty data). The file's URL was inserted as text.

Paste and drop were then moved to Rust (commits 1b971c2 and ab20f40) and re-checked on the same desktop.

**Conditions:**
- Build: the release binary of ab20f40. R4 and R6–R8 ran with two temporary `eprintln!` logging lines that were not committed.
- Display: the owner's GNOME 46 Wayland session, through XWayland (`:0`).
- Data: a scratch `HOME` and a private D-Bus daemon, so the owner's notes were untouched.
- Input: clipboard owners and a drag source were small GTK helper programs, and clicks and keys were sent with libxdo.

| # | Check | Result |
|---|---|---|
| R1 | Ctrl+V with only `image/png` on the clipboard (like a screenshot) | The image is added (800 × 500 PNG) |
| R2 | Ctrl+V with `image/png` and text | The image is added |
| R3 | Ctrl+V with `image/png` and `text/html` holding only `<img src="https://…">` (a browser's "Copy Image") | The image is added from the clipboard pixels. Nothing is fetched. |
| R4 | Select an image in a note, Ctrl+C, then Ctrl+V | The page gets `types ["text/html","text/plain"]` with our own `<img data-image-id>`. The same image is pasted, as a second node with the same id. |
| R5 | Ctrl+V with HTML of a paragraph and a table, plus plain text and a PNG (an office copy) | Pasted as text ("Quarterly figures" and the table's text). No image is added. |
| R6 | Drag an image file (`text/uri-list`) onto a note's text | The image is inserted exactly at the drop point, splitting the line there |
| R7 | Drag a web link onto a note | Inserted as plain text. No image and no message. |
| R8 | Two notes open; drop an image on note 1 | Only note 1 changes. Note 2 is untouched. |

## Not checked in the real app

| Item | Why |
|---|---|
| **Moving text by dragging it inside a note** (Tauri's file-drop handler is on again) | A synthetic text drag did not start a WebKit drag here. Reading the wry source shows it only takes `text/uri-list` drops and leaves everything else to WebKit. **Owner check.** |
| **Dropping a photo from the Files app** | Files is a native Wayland app that a synthetic mouse cannot drive. R6 covers the same path from an X11 drag source. **Owner check.** |
| **A BMP or TIFF on the clipboard** | Unit tests cover the conversion. No app that copies BMP or TIFF was at hand. |
| **Images of private notes withheld while locked** | The scheme cannot be called from outside the webview here. The core tests `image_for_display_respects_the_lock` and `an_unreferenced_image_is_served_while_locked` cover the rule the scheme uses. A locked note's content is already empty in the webview, so no image address reaches it. |
| **The 300 MB backup limit** | Tested in core with a lower limit. |

## Automated tests

`npm test` (765), `npm run lint`, `npm run typecheck`, `cargo test --workspace`,
`cargo clippy -D warnings` and `cargo fmt --check` pass. Every task was reviewed separately,
and each review fix was re-reviewed.
