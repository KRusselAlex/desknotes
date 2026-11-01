# Milestone 2 — verification on Ubuntu

Machine and method as in `m1-verification.md` (Ubuntu 24.04 GNOME, XWayland, debug build,
isolated test data, `scripts/verify/`).

## Always on top (design B2) — 2026-11-01

| Check | Result |
|---|---|
| Pin button in the header turns it on | `_NET_WM_STATE_ABOVE` set on the window by Mutter; saved in the database |
| Pin stays visible while reading; click turns it off | Matches design B2 (screenshot checked) |
| "Always on top" in the ⋯ menu | Checkbox item reflecting the current state (unit test) |
| Restart | Note reopens with `_NET_WM_STATE_ABOVE` |

## Collapse to header (design B3) — 2026-11-01

| Check | Result |
|---|---|
| Collapse from the header chevron | Window 300 × 32; database keeps the expanded height 280 |
| Expand from the strip chevron | Window back to 300 × 280 |
| Restart while collapsed | Reopens as a 300 × 32 strip |
| Text typed before collapsing | Saved first; collapsing is refused while a save is failing (unit test) |

Found while testing: a non-resizable GTK window is forced to its content's natural size
(300 × 200 for a WebKit view), so the strip first came up 200 px tall. Collapsed windows
now stay resizable with equal minimum and maximum heights (32 px).

Not checked yet: double-clicking the strip to expand with the real mouse.

## Settings window: General and About (designs S2, S4) — 2026-11-01

| Check | Result |
|---|---|
| Manager ⋯ → Settings… | Opens a 680 × 520 "Settings" window; it shares the single WebKit process |
| Launch at login on | Writes `~/.config/autostart/DeskNotes.desktop` (Exec = the running binary) |
| Launch at login off | Removes that file; other apps' entries (`xpad.desktop`) untouched |
| Colour for new notes = Mint | The next new note is created `#c8f7c5` |
| About | Version, "MIT license", data folder path, "No data leaves this computer." |

Not checked in the real app: "Open folder" (it opens the file manager; covered by a unit
test). Privacy, Appearance and Backup sections will appear as those features are built.

## Backup and restore (design S3) — 2026-11-01

Automated: core round trip (export then restore reproduces every note exactly, including
archived and trashed ones and window state), safety copy before restore, validation of
every field (format, version, ids, duplicates, content allowlist and links, colours,
numbers), damaged notes reported on export; 7 UI tests for the Backup pane.

**Checked by the owner in the real app:** export through the save dialog, restore through
the open dialog and confirmation, notes replaced and reopened (2026-11-01).

## .deb package (DES-17) — 2026-11-01

Built with `npm run tauri build -- --bundles deb` (release profile, LTO, stripped).

| Check | Result |
|---|---|
| Package | `desk-notes` 0.1.0, 4.7 MB file, 10.3 MB installed; Maintainer, Homepage, Section set; license in `/usr/share/doc/desk-notes/copyright` |
| Depends | `libwebkit2gtk-4.1-0`, `libgtk-3-0` |
| This Ubuntu desktop (simulated) | Installs only DeskNotes: 0 extra packages |
| Bare Ubuntu 24.04 container | apt pulls 277 packages (131 MB download, the GTK/WebKit stack); no missing library (`ldd`) |
| Start in the container | Runs under a virtual display (still running after 10 s) |
| Desktop entry | `Name=DeskNotes`, `Exec=desknotes`, `Icon=desknotes`, menu category Office |
| Uninstall | `apt remove desk-notes` removes the binary; notes are kept |

Not checked: installing the package on the owner's own desktop (needs sudo).

## AppImage built in CI (DES-17) — 2026-11-01

Built by the **Packages** workflow on GitHub's runner (pull request #6); checksums in
`SHA256SUMS` verified after download.

| Container (Ubuntu 24.04, Xvfb) | Result |
|---|---|
| Bare, nothing installed | Does not start: `libfribidi.so.0` missing (AppImages expect basic desktop libraries) |
| GTK only | Does not start: `libEGL.so.1` missing (graphics drivers are never bundled) |
| GTK + EGL/GL graphics libraries, **no WebKitGTK** | Starts and keeps running (WebKitGTK comes from inside the AppImage) |

Size: AppImage 83 MB (it carries WebKitGTK), `.deb` 4.7 MB. On Ubuntu 22.04 and later,
running an AppImage needs `libfuse2t64`, or `--appimage-extract-and-run`.

## Bug: a pasted link made a note unsavable — 2026-11-01

Reported by the owner: in the installed 0.1.0 package, a note showed "Not saved" and Quit
refused. Their database (inspected read-only, metadata only) held the note empty: no save
had ever succeeded for it, while other writes worked.

Cause: Tiptap copies a pasted link's `target` attribute as it is (`_self`, `_top`, empty…).
The core accepts only `_blank` or none, and the editor's safety pass checked only `href`,
so every later save of that note was refused and Retry could not help.

| Check | Installed 0.1.0 | Fixed build (release, isolated data) |
|---|---|---|
| New note, type "Pasted: ", paste `<a href="https://example.com/" target="_self">` (HTML clipboard on the X display) | "Not saved"; database keeps an empty note (the typed words are lost too) | "Saved"; link stored with `target: "_blank"` |
| Save refused for another reason (note locked in the test database behind the app's back) | no trace anywhere | stderr: `a note was not saved (not_allowed): …`; no note text in the line |

Also checked outside the app: 20 pasted HTML samples (links with various targets, relative,
`tel:`, Google results, lists, code, tables, images) parsed by the editor configuration and
validated by the real Rust core: 4 refused before the fix, none after. A note already holding
such a link saves again on the next Retry, because the fix also runs on every save.

Not shown in a screenshot: the hover tooltip with the reason (GTK draws it as a separate
window); covered by a unit test.
