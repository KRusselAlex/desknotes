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

## Not checked in the real app

| Item | Why |
|---|---|
| **Paste (Ctrl+V) of a screenshot or a browser's "Copy Image"** | The clipboard cannot be read on a bare hidden display: even a plain GTK program could not read it, as in the DES-29 check. A clipboard image set by a GTK helper was not pasted. Unit tests cover the paste logic, including Word/LibreOffice pastes staying text. **Owner check** with the `.deb`. |
| **Dropping a file from Files onto a note** | Needs a real file manager and drag session. **Owner check.** |
| **Images of private notes withheld while locked** | The scheme has no way to be called outside the webview here. The core tests `image_for_display_respects_the_lock` and `an_unreferenced_image_is_served_while_locked` cover the rule the scheme uses. A locked note's content is already empty in the webview, so no image address reaches it. |
| **The 300 MB backup limit** | Tested in core with a lower limit. |

## Automated tests

`npm test` (744), `npm run lint`, `npm run typecheck`, `cargo test --workspace`,
`cargo clippy -D warnings` and `cargo fmt --check` pass. Every task was reviewed separately,
and each review fix was re-reviewed.
