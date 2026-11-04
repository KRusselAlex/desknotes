# Per-note settings window — design (Milestone 3, DES-19)

Date: 2026-11-03 · Jira: DES-19 (parent DES-4)
Sources: owner's Claude Design export "DeskNotes Lock Settings Reminders" → section
**Note settings** (B · 400 px wide, scrolls, changes apply live, light and dark);
`docs/ui-design-brief.md` §3.6; opacity spike in `docs/testing/m2-verification.md`.

The owner chose to skip the question round ("go"). Everything below the design export
and the brief is marked **(my call)** so the owner can check those while reading.

## 1. Intent

Let one note look different from the others — bigger text for a note read from across
the desk, a terracotta reminder, a see-through note that does not hide what is behind it —
without touching any other note, and without leaving the note to find the controls.

## 2. Goals, non-goals, anti-goals

Goals
- A **Note settings** window for one note, opened from that note's ⋯ menu, laid out as in
  the design: cards **Text**, **Background**, **Size**, **Behaviour**; footer
  **Reset to defaults** and **Close**.
- Every change applies to the note **live**, while the window is open, and is saved.
- Settings survive restarts, are kept by Duplicate, and are kept by backup and restore.

Non-goals
- Background images. The row is shown disabled with "Later", as in the design.
- App-wide defaults for these settings (a later Settings → Appearance could add them).
- Per-paragraph formatting: these settings style the whole note; the format bar still
  styles selected text as before.

Anti-goals (a failure even if it "works")
- Losing or rewriting note text when a setting changes (for example while the window
  has to be recreated for opacity).
- A setting that makes the text unreadable without saying so.
- Note text (title, content) in any window title. The design's title bar reads
  "Note settings — Weekend errands"; CLAUDE.md forbids note text in window titles, so the
  OS title is **"Note settings"** only (my call, forced by the non-negotiable).
- Any network access (fonts come from the local system only).

## 3. What each control does

### 3.1 Text
| Control | Values | Default | Notes |
|---|---|---|---|
| Font | "System default", then the font families installed on this computer, A–Z | System default (`--dn-font`) | List read locally by the Rust side, once per window opening (my call). A family that is later uninstalled falls back to the system font. |
| Size | 10–32 px, steppers −/+ by 1 | 15 (`--dn-text-base`) | Title line and in-note headings scale with it (they keep their ratio to 15) (my call). |
| Text colour | 4 swatches from the design: `#201e1d`, `#8c491a`, `#56633f`, `#1d4f91` | `#201e1d` | No custom text colour (the design shows none). |
| Line spacing | slider 100–200 %, step 5 | 145 % (`--dn-leading`) | |
| Direction | Automatic / LTR / RTL (segmented) | Automatic | Automatic = `dir="auto"` per paragraph. |

### 3.2 Background
| Control | Values | Default | Notes |
|---|---|---|---|
| Colour | the 8 note colours + "+" custom colour | the note's current colour | Same storage as today's note colour (`notes.color`); the header shade is derived as today. |
| Opacity | slider 80–100 %, step 5 | 100 % | Hint under it, from the design: "Lowest allowed: 80 %, so text stays readable. Needs a compositor; ignored otherwise." Only the background (body and header) becomes see-through; text, icons and controls stay opaque. |
| Background image | disabled row, "Later" | — | Not built. |

**Readability warning (my call):** when the chosen text colour on the chosen background
has a contrast below 4.5 : 1, the Background card shows a one-line hint "Text may be hard
to read on this colour." Nothing is blocked.

**Opacity and the window (from the spike):** a note window is created with
transparency only when its opacity is below 100 %. Moving the slider from 100 % to
below (or back to 100 %) therefore **recreates that note window** at the same place and
size: the note is saved first (the existing save round), then closed and reopened; the
settings window stays open (my call). Moves that stay below 100 % apply live without
recreating. On a desktop without a compositor the note simply looks opaque.

### 3.3 Size
- **W × H** number fields in pixels (logical), applied when the field is committed
  (Enter or leaving the field) (my call). Limits: at least the "Minimum note size"
  setting, at most the size of the screen the note is on.
- **Lock aspect ratio** switch: while on, changing W changes H (and the other way) to keep
  the ratio the note had when the switch was turned on. It applies to these fields only;
  dragging the window edge is not constrained (my call: GTK under Tauri gives no reliable
  aspect hint; noted as a later improvement).
- **Reset size**: 300 × 280 (`--dn-note-w`, `--dn-note-h`), or the minimum note size if
  that is larger.
- Dragging the note's edges while the window is open updates the fields.
- A collapsed note: the fields show its full size; changing them expands nothing and the
  new size is used when it is expanded (my call).

### 3.4 Behaviour
- **Lock editing** and **Always on top** switches, the same states as the note's ⋯ menu
  and header pin; changing either place updates the other.

### 3.5 Footer
- **Reset to defaults** resets Text, Opacity and Size to the defaults above; it keeps the
  background colour and the Behaviour switches (they are states, not styling) (my call).
  No confirmation: every value is visible and can be set back.
- **Close** closes the window (Esc does too).

## 4. The window

- One **Note settings** window at a time (label `note-settings`), 400 px wide, height to
  fit the screen (about 640 px), content scrolls; light or dark like the other app windows.
- Opened from the note's ⋯ menu item **"Note settings…"** (icon `settings`), placed
  beside the note when there is room (my call). Opening it from another note switches the
  window to that note.
- The window shows no note text at all (no title, no snippet): a small swatch of the note
  colour in its header identifies it (my call; this also keeps private notes private).
- If the note is closed, trashed, archived or purged, the window closes.
- **Private notes:** the menu is not reachable while the note is locked. If the lock
  engages while the window is open, the window stays (it shows no text) and changes still
  apply — they reveal nothing (my call).
- Shares the manager's web process like the other windows (ADR-0006).

## 5. Data and validation (core)

- New appended migration **v5**: `notes.appearance TEXT NOT NULL DEFAULT '{}'`: a JSON
  object validated in Rust with known keys only: `font` (string ≤ 100 chars; no control
  characters, quotes, backslash or semicolon), `fontSize` (10–32), `textColor` (one of the
  4 presets), `lineSpacing` (100–200, multiple of 5), `direction` (`auto`/`ltr`/`rtl`),
  `opacity` (80–100, multiple of 5). Missing keys mean the default; unknown keys are refused.
  Existing notes need no rewrite (default `'{}'`).
- Background colour keeps using `notes.color` and `set_note_color`.
- Size uses the existing window geometry; a new command sets a note window's size.
- Duplicate copies `appearance`. Backup format **3** adds `appearance`; formats 1 and 2
  still import (defaults).
- New Tauri commands (names are the builder's): get/set a note's appearance, set a note
  window's size, open the note settings window, list system fonts. The webview calls them
  only through `src/ipc`.
- Every note window and the settings window refresh through the existing
  `note-changed`-style event; the note must not reload its editor content to restyle.

## 6. Constraints

- Tokens and icons only from `src/styles/tokens.css` and `src/components/icons.ts`; the
  layout and copy follow the design export (desknotes-build-from-design).
- Note windows: created hidden then shown (37 px rule), XWayland, shared web process.
- No note text in titles; offline; all SQL in the core; migrations appended only.
- Tests for validation, migration, backup round-trip, duplicate, and the UI behaviour;
  real-app checks recorded in `docs/testing/`.

## 7. Left to the builder

- How the font list is read (a pure-Rust font database or fontconfig), as long as it is
  local, cached per opening, and failure leaves just "System default".
- Exact event payloads and how the note applies styles (CSS variables on `.dn-note`).
- How the window is recreated for the opacity switch, as long as text is saved first and
  position, size, collapsed and always-on-top state are kept.
