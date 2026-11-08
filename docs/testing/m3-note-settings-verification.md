# Milestone 3 — per-note settings: verification on Ubuntu

Date: 2026-11-03 · Branch: `feat/m3-note-settings` (517c357) · Jira: DES-19
Design: `docs/superpowers/specs/2026-11-03-note-settings-design.md`

## Machine and conditions

| Item | Value |
|---|---|
| OS | Ubuntu 24.04.5 LTS, GNOME 46 on Wayland; DeskNotes through XWayland (ADR-0002) |
| Build | release binary (`npm run tauri build -- --no-bundle`), not the `.deb` |
| Data | isolated test folder (`XDG_DATA_HOME`), not the owner's notes; the owner's DeskNotes was quit for the run (with their agreement) and restarted afterwards |
| Method | clicks with libxdo (`scripts/verify/x.py`), screenshots of the real windows, `xwininfo`/`xprop`, database read-only |
| Test note | four paragraphs (English, English, Arabic, English) written into the scratch database before starting, because synthetic typing did not reach the note under Wayland in this session |

## Checked in the real app

| Check | Result |
|---|---|
| Note ⋯ menu | "Note settings…" right after "Always on top" |
| Opening the window | One window titled exactly **"Note settings"** (no note text), 400 × 640, placed 12 px right of the note, focused on opening |
| Layout | Text, Background, Size cards and Reset to defaults / Close as in the design export; header shows only the note colour swatch |
| Font list | "System default" first, then the families installed on this computer A–Z (Accanthis ADF Std, Amiri, Andika, …; 440 families from `fc-list`) |
| Live changes | Size 15 → 18, text colour blue, line spacing 190 %, background peach: the note changed at once; database holds `{"fontSize":…,"textColor":"#1d4f91","lineSpacing":190,…}` |
| Direction Automatic | English paragraphs left-to-right, the Arabic paragraph right-to-left and right-aligned — decided per paragraph |
| Direction RTL | Every paragraph right-to-left |
| Opacity 100 → 80 % | Note window recreated at the same place and size, `Depth: 32`; header and body equally see-through (one paint); text kept; always-on-top kept |
| Opacity 80 → 100 % | Recreated again, `Depth: 24`, same place and size |
| Resizing the note by its edge | W × H fields followed (360 × 330) |
| Reset size | Note back to 300 × 280 |
| Restart | Font (Amiri), size, colour, direction, background and always-on-top all kept |
| Reset to defaults | Appearance stored as `{}`; background colour and always-on-top kept |
| Close | Window closes (its own capability allows close) |
| Note moved to trash while the window is open | The settings window closes; the manager shows |
| Web processes | One `WebKitWebProcess` for the manager, note and settings windows (ADR-0006) |

## Not checked in the real app (covered by automated tests only, or left)

| Item | Why |
|---|---|
| Focus staying on the settings window after an opacity crossing | Synthetic clicks do not move GNOME's focus under Wayland (`_NET_ACTIVE_WINDOW` stayed 0 throughout), so the result cannot be read with these tools. Mutter flagged both windows "demands attention" after the recreation — **owner check needed**. |
| Typing in the W/H fields, Lock aspect ratio, a resize near the screen edge, a collapsed note's size | Need keyboard input, which did not reach the windows in this session; unit tests cover clamping, aspect and keep-on-screen |
| Crossing 100 % while typing | Typing not possible here; the save-then-reopen order and the failed-save case are unit-tested |
| Custom colour "+" (GTK colour dialog), Lock editing / Always on top switches in the window | Not exercised (Behaviour card below the fold); the switches use the existing commands |
| Backup export/import of appearance | Core round-trip tests; no file dialog run |

## Automated tests at the end of the branch

`cargo test --workspace` (core 100 + 16 + 1, desktop 60), 274 frontend tests, `cargo clippy -D warnings`,
`npm run lint`, `npm run typecheck`: all pass. Each task was reviewed separately, then the whole branch;
findings fixed and re-reviewed.

## DES-31 batch 1: shell and core fixes (2026-11-08)

Debug build of `fix/des-31-note-settings` on a hidden X display (Xvfb `:78`, no window
manager, private D-Bus, scratch HOME with only the welcome note). Driven with
`scripts/verify/x.py`; the window's colour depth tells whether it was created
transparent (32) or not (24).

| Check | Result |
|---|---|
| Opacity 100 → 95 % (slider, Left key) | Note window recreated (new X id), `{"opacity":95}` saved |
| 95 → 90 % | Same window kept: no needless reopen |
| 90 → 95 → 100 % | Kept at 95, recreated at 100, appearance `{}` |
| Quick 95 → 100 → 95 % (three key presses, no pause) | Ends with one window, `Depth: 32`, `{"opacity":95}` saved |
| Then 95 → 100 % | Recreated, `Depth: 24`; text and place kept |
| Font picker | Opens with "System default" then the installed families (now read through the 5 s time limit) |

Not checked in the real app: a strip resize that fails (cannot be caused from outside; the
rollback is a few lines of code), a collapsed note wider than 4096 px (needs a screen that wide),
and the font-list time limit itself (unit-tested with a slow command).

## DES-31 batch 2: Note settings window and note look (2026-11-08)

Debug build of `fix/des-31-note-settings-ui`, same hidden X display set-up as batch 1
(fresh scratch HOME, welcome note only). Keys sent with `scripts/verify/x.py` after
giving the window keyboard focus.

| Check | Result |
|---|---|
| Note window page `index.html?color=…` | Opens and draws the note as before |
| Note settings opens | Font has the focus ring at once |
| Tab ×3, Right, Space on Text colour | Focus moved Black → Brown; Space chose it; `{"textColor":"#8c491a"}` saved |
| Opacity 100 → 95 % | Note reopened `Depth: 32` with its brown text |
| A checklist in that note | Box borders brown (the text colour, was the default ink); a ticked box is brown with a solid lemon tick at 95 % |
| Direction RTL with a bullet list and a checklist | Bullets and boxes on the right, indent on the right |

Not checked in the real app: the first frame's colour (it lasts one frame), focus while switching
notes, and a cancelled slider drag (needs a touch screen or the system taking the pointer).
These are unit-tested.

