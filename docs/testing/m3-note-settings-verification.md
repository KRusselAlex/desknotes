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
