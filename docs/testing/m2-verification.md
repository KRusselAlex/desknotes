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

Installed by the owner on their Ubuntu 24.04 desktop with `sudo apt install`: works
(`dpkg`: desk-notes 0.1.0 installed, 10.6 MB; binary, desktop entry and icons present).

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

## Tray icon, Hide all, Show hidden notes — 2026-11-01

Driven through the tray's D-Bus menu (`scripts/verify/tray.py`, the same interface GNOME
Shell's AppIndicators extension uses), debug build, scratch data.

| Action | Result |
|---|---|
| Tray registered | `org/ayatana/NotificationItem/tray_icon_tray_app_main` owned by DeskNotes; items New note, Hide all notes, Show hidden notes, Open manager, Settings…, Quit DeskNotes |
| New note (twice) | 2 note windows, both visible in the database |
| Hide all notes | 0 note windows; both hidden in the database; both ids remembered |
| Show hidden notes | 2 note windows again; both visible |
| Quit DeskNotes | Process exits |

Also checked with the installed release build (scratch data): clicks in the manager work,
"New note" works, and ⋯ → Quit DeskNotes exits immediately.

Not checked: the icon's look in the top bar (needs a person), and the "no tray" fallback
(Hide all opens the manager) in a desktop without AppIndicator support.

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

## Edit lock (DES-18) — 2026-11-01

Release build with the DES-25 fix, isolated data, input simulated with `scripts/verify/`.

| Check | Result |
|---|---|
| Type, then lock from the More menu 341 ms later (inside the 500 ms autosave delay) | **Pass**: the last words were saved first, then `edit_locked = 1`; no "Not saved", no refused save in the log |
| Locked note | **Pass**: "Read-only" chip, formatting bar hidden, checklist boxes drawn dashed |
| Click a checklist box while locked | **Pass**: stays unticked; content and `updated_at` unchanged; no save attempted |
| Type while locked | **Pass**, confirmed by the owner with a real keyboard |
| Restart | **Pass**: the note reopens read-only |
| Click the "Read-only" chip | **Pass**: `edit_locked = 0`, formatting bar back |
| Type after unlocking | **Pass**, confirmed by the owner with a real keyboard (simulated typing cannot reach a restored window on GNOME) |

Decision recorded: checklist boxes cannot be ticked while a note is locked (the lock means
no change at all, as the owner asked: "fully frozen").

## Spike: floating controls and background opacity (DES-21) — 2026-11-01

**Floating controls: not needed.** The owner's Note Window design keeps every control
inside the note's coloured area ("no transparent window margin is needed"), which is how
the app is built. The click-through question for a transparent strip around the note
therefore no longer applies and was not tested.

**Background opacity: works on Ubuntu 24.04 GNOME (XWayland).** Tested with a throwaway
build (branch `spike/des-21-opacity`, not merged): note windows created with
`transparent(true)` and the note background drawn at 55 % opacity, text fully opaque.

| Check | Result |
|---|---|
| Window visual | Note window gets a 32-bit ARGB visual (`xwininfo`: Depth 32); the manager stays 24-bit |
| Shared web process (ADR-0006) | Still one WebKit web process with a transparent note open |
| Hidden-then-shown creation | Note opened at exactly 300 × 280 (no 37 px growth) |
| Saving | Typed text saved as usual |
| On screen | **Owner confirmed**: the window behind shows through the note body, and the text stays readable |

Not checked: desktops without a compositor (there, transparency is unavailable and the note
must look right at 100 %, as the design brief says); per-pixel capture of the composited
screen (XWayland refuses root captures and GNOME restricts its screenshot service).

Outcome for DES-19 (per-note background opacity): feasible. Make only the background
translucent, keep text and controls opaque, set a minimum opacity that keeps text readable,
and create a note window transparent only when its opacity is below 100 %.

## New .deb from main (69e00dd) — 2026-11-02

Checked on scratch data before handing it over: tray menu with its six items, Hide all /
Show hidden (database matches) and Quit work; a new note opens and saves. **Confirmed by the
owner** after installing it on their desktop: a link pasted from a web page now saves
(DES-25). The package still says version 0.1.0; versioning is part of DES-22.

## Minimum note size (DES-26, design S2) — 2026-11-02

Release build, isolated data. Setting range: 180–600 × 120–600 px (180 × 120 is the floor
the note layout needs and the design's default).

| Check | Result |
|---|---|
| Settings → General | Row "Minimum note size 180 × 120 px" as in the design (light and dark checked in the preview) |
| Type 350 in the width field, Enter | Saved as 350 × 120; the open 300 px note grows to 350 on screen and its size is saved |
| Resize that note to 200 × 150 | Stops at 350 wide; the 150 height is allowed |
| Type 900 | Banner gives the reason, the field returns to 350, the saved value is unchanged |
| Restart | Setting kept; the note reopens at 350 × 150 |
| Show a hidden 300 px note | Opens at 350 × 280, size saved |
| Collapse, try to shrink, expand | Strip is 350 × 32 and cannot shrink; expands back to 350 × 150 |
| After review fixes: two hidden 300 × 280 notes, minimum 400 × 300, Show hidden notes | Both open at 400 × 300 and that size is saved; the same after a restart |

Raising the minimum enlarges smaller notes (GTK cannot keep a window below its minimum);
lowering it later does not shrink them back.

Test-tool notes: GNOME does not move keyboard focus to an existing window on simulated
clicks, so typing went to the focused note until the Settings window was opened anew.
`scripts/verify/x.py list` lists windows titled "DeskNotes" only, not "Settings".

## Show / hide all shortcut (DES-27) — 2026-11-02

**Platform facts (Ubuntu 24.04, GNOME Shell 46.0, xdg-desktop-portal-gnome 46.2):**
- The XDG GlobalShortcuts portal is not offered (the desktop portal exposes only Background
  and Settings); it arrives with GNOME 48.
- An X11 key grab from XWayland only sees keys while one of DeskNotes' own windows has
  focus, so it cannot be a global shortcut.
- A GNOME custom keyboard shortcut can run any command globally. Ctrl+Alt+N is not used by
  GNOME here (read-only check of the window manager, shell and media-keys bindings).

**Part 1, the command:** `desknotes --toggle-notes`. A second launch hands it to the running
DeskNotes (single instance). Release build, isolated data:

| Situation | Result |
|---|---|
| Two notes on screen | Second launch exits in ~135 ms (code 0); both notes hidden (saved first) |
| Run again | Both notes back |
| DeskNotes not running | It starts DeskNotes |
| No notes on screen and none remembered (the manager is then on screen) | Manager stays; no error |

**Real key press, confirmed by the owner (2026-11-02):** they added a GNOME custom shortcut
by hand (Ctrl+Alt+N running the release build with `--toggle-notes`); pressing it hides and
shows their notes. From a terminal, the same command started DeskNotes, then hid and showed
the note.

**Part 2, setting up the GNOME shortcut (backend only, no UI yet):** module
`src-tauri/src/platform/gnome_shortcut.rs` and commands `get_toggle_shortcut`,
`set_toggle_shortcut`, `remove_toggle_shortcut`. Tested with the real GIO settings code
against a **scratch keyfile backend** (`GSETTINGS_BACKEND=keyfile`, scratch
`XDG_CONFIG_HOME`; the test refuses to run otherwise):

| Check | Result |
|---|---|
| Install Ctrl+Alt+N next to another custom shortcut | Both in the list, in order; name, command and key written |
| Conflicts | Another custom shortcut on Super+E is reported by name; GNOME's Ctrl+Alt+T is reported as "terminal"; Ctrl+Alt+N is free |
| Remove | Only DeskNotes' entry goes; the other shortcut keeps its name, key and place |
| The owner's own GNOME settings | `dconf dump` of media-keys identical before and after |

Not checked yet: DeskNotes adding the shortcut itself on a real desktop (waits for the
Settings dialog design; the owner's hand-made shortcut shows the key press works).
