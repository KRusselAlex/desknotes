# Milestone 3 — Aa text-style popover: verification on Ubuntu

Date: 2026-11-04 · Branch: `feat/m3-text-style` (c169c56) · Jira: DES-32
Design: `docs/superpowers/specs/2026-11-03-text-style-design.md` (owner's design N14, N12)

## Machine and conditions

| Item | Value |
|---|---|
| OS | Ubuntu 24.04.5 LTS, GNOME 46 on Wayland; DeskNotes through XWayland (ADR-0002) |
| Build | release binary (`npm run tauri build -- --no-bundle`), not the `.deb` |
| Data | isolated scratch folder (`XDG_DATA_HOME`), not the owner's notes; the owner's DeskNotes was quit for the run (with their agreement) and restarted afterwards, its database untouched |
| Method | clicks and drags with libxdo (`scripts/verify/x.py`), screenshots of the real windows (including the GTK font dropdown), database read with Python `sqlite3` |
| Test note | five blocks (title line, English paragraph, heading "Shopping", Arabic paragraph, English paragraph) written into the scratch database before starting; note direction Automatic; window 320 × 380 as in N14 |

## Checked in the real app

| Check | Result |
|---|---|
| Opening the note | Not saved on open: `updated_at` stayed equal to `created_at` until the first real change |
| Aa button | At the end of the bar after Link and a divider; opens the popover upward; the selection stays highlighted |
| Layout | Font, Size (− 15 +) with weight, Text (6 swatches), Highlight (× and 4), align / AB ab / undo redo — as N14 |
| Live changes on "Pick up the bike" | Blue, size 16, yellow highlight, then AB: the note changed at once, the popover stayed open, swatches ringed, Undo enabled |
| Title line | Popover shows **18** and **Semibold** (what is drawn), not the note size 15 |
| Arabic paragraph, Automatic direction | Popover shows **Align right** pressed; Align left made it left-aligned; stored `textAlign: "left"` |
| Font dropdown (native GTK list) | Lists "System default" then installed families A–Z; the bar and popover stayed while it was open; choosing **Amiri** drew "Last line" in Amiri |
| Saved content | Database holds `textStyle` (`#1d4f91`, `16px`; `Amiri`), `highlight` (`#ffe36e`), `textAlign` only where set (no `null` on untouched blocks); upper-cased text is real text (search finds "pick up the bike") |
| Restart | All formatting back as before |
| Narrow note (200 px) | Overflow menu shows "Text style…" after Heading; it opens the same popover, rows stacked, scrolling; in the heading it shows 17 / Semibold |

## Not checked in the real app (owner checks)

| Item | Why |
|---|---|
| Pasting from a web page in Chrome/Chromium and in Firefox (styles should be dropped, bold kept), and copy/paste inside DeskNotes (formatting kept) | Setting the clipboard would have overwritten the owner's clipboard; unit tests cover both paths, including a real ProseMirror clipboard round trip |
| Keyboard use of the popover (Tab, arrows, Esc) and Ctrl+Shift+H / L / E / R | Synthetic keys do not reach the windows under Wayland in this session; unit tests cover focus staying in the popover and the shortcuts |
| Dragging the popover's scrollbar in a short note | Mouse-down inside the popover is held to keep editing; wheel scrolling is the expected way, not checked by hand |
| A font later uninstalled falling back to the note's font | Needs uninstalling a font; the rendered `font-family` fallback is unit-tested |
| Dark theme | The note body keeps its pastel colours; the popover uses the same surface as the other note popovers |

## Automated tests at the end of the branch

461 frontend tests, `cargo test --workspace`, `cargo clippy -D warnings`, `npm run lint`, `npm run typecheck`: all pass.
Each task was reviewed separately, then the whole branch; findings fixed and re-reviewed.

## DES-33 batch 1: core checks, Aa popover and case (2026-11-08)

Debug build of `fix/des-33-text-style` on a hidden X display (Xvfb `:78`, no window manager,
private D-Bus, scratch HOME with only the welcome note), keys and clicks sent with
`scripts/verify/x.py`.

| Check | Result |
|---|---|
| Title line selected, Aa opened | Weight shows **Bold** (was Semibold); size 18 |
| "ab" on the selected title | Title lower-cased; Undo enabled |
| Esc with the text focused | Popover closes, selection and focus stay in the text (two runs) |

Found on the way: the first attempt at "one Esc closes one thing" skipped an Esc whose default
was already prevented. In WebKitGTK the editor prevents Esc's default, so the popover stopped
closing on Esc. An on-screen probe showed `Escape defaultPrevented=true`. The link editor now
stops its own Esc instead, and a unit test dispatches an Esc already marked as handled.

Not checked in the real app: Semibold chosen on the title (needs the native select list), the
Greek final sigma (needs Greek typed), and Esc in the link editor while Aa is open. These
are unit-tested.

## DES-33 batch 2: paste, copy and checklists in Automatic direction (2026-11-08)

Debug build of `fix/des-33-paste`, hidden X display, scratch HOME. A note was put in the
throwaway database with an Arabic first line, a checklist ("Milk", "خبز") and a paragraph
in DejaVu Serif; direction Automatic.

| Check | Before | After |
|---|---|---|
| "Milk" item | Box on the right, text right-aligned (followed the Arabic first line) | Box on the left, text from the left |
| "خبز" item | Box on the right | Box on the right |
| Paragraph "Font" | Left | Left (unchanged) |

Found on the way: with only the item's `dir` set, "Milk" kept its box on the left but its
text on the right. WebKit gives list items `text-align: match-parent`. Temporary outlines
showed it, and `text-align: start` on checklist items fixed it.

Not checked in the real app: the clipboard HTML, because no clipboard tool is installed on
this machine. Bold with a stored Regular weight copied inside DeskNotes, and pastes from
other apps, are covered by unit tests that go through ProseMirror's own clipboard
serializer and paste parser. Pasting from Chrome and Firefox is still an owner check.

Review follow-up (same day):
- A parent checklist item now takes its side from its own line only.
- The item directions are rebuilt only when the text changes.
- `text-align: start` was tried on every list item and dropped: an English bullet under an
  Arabic first line then had its text on the left but its marker hanging at the left edge,
  because the list's indent stays on the right.

Still open (pre-existing): in Automatic direction, a bullet or numbered item follows the
note's first line's side, so choosing Left on it stores nothing and changes nothing.
