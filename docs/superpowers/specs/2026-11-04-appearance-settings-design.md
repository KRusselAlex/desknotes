# Settings → Appearance — design (Milestone 3, DES-34)

Date: 2026-11-04 · Jira: DES-34 (parent DES-4)
Sources (owner's Claude Design exports):
- "DeskNotes Lock Settings Reminders" → **B · S4 Appearance**: the High-contrast notes switch, Layout (Compact / Comfortable), Default font, Default size (− 15 +) and Reset appearance; the Settings sidebar order General · Appearance · Privacy · Backup · About.
- "DeskNotes Note Window" → **B · High contrast**: "Any colour → White, black ink, 2 px rules, 3 px focus ring · 21:1".
- "DeskNotes Note Window" → **B · B4 Compact vs comfortable**: "Compact: 13.5 px text, 10 px side padding, 28 px header. Comfortable (default): 15 px, 16 px, 32 px. Buttons stay 28 px in both."
- `docs/ui-design-brief.md` (Appearance) and `docs/design.md` §6 ("high-contrast + compact layouts, reset appearance").

The owner said "continue" instead of answering questions. Everything that is not in the design export or the brief is marked **(my call)**.

## 1. Intent

Set how **every** note looks by default, in one place:
- high contrast for reading in bright light or with low vision;
- a compact layout to fit more notes on a small screen;
- a default font and size so that new and existing notes match.

Note settings (DES-19) styles one note, and the Aa popover (DES-32) styles selected text. Both still win over these defaults.

## 2. Goals, non-goals, anti-goals

### Goals
- A new **Appearance** section in Settings, between General and Privacy, laid out as S4.
- **High-contrast notes** (switch). Every note is drawn as in "B · High contrast": white background, black ink (21:1), 2 px rules, 3 px focus ring. This applies whatever its colour.
- **Layout** (Compact / Comfortable, segmented), as in B4.
- **Default font** (dropdown: "System default", then the installed fonts) and **Default size** (stepper − / +, 10–32 px). These apply to notes that have no font or size of their own in Note settings.
- **Reset appearance** puts these four settings back to their defaults.
- Every change applies **live** to every open note, is saved, and is kept after a restart.

### Non-goals
- A dark theme for notes. Notes keep their light colours; the app windows already follow the system theme.
- Changing any note's own settings. Nothing here writes to a note.
- The About pane's content (S4 also shows it). It already exists and is not part of this work.

### Anti-goals (failures even if it "works")
- Losing or rewriting a note's own colour or Note settings when high contrast or a default changes. Turning high contrast off must bring every note back exactly as it was.
- Unreadable text: high contrast must stay 21:1 even on see-through notes or text with its own colour.
- Note text in any title, log or notification.

## 3. What each control does

### 3.1 High-contrast notes
- When on, every note window, collapsed strip and the private-lock state is drawn as follows:
  - background `#ffffff`;
  - ink `#000000` for text, icons and checkboxes;
  - 2 px black rules where a note today has a thin line or border: the header's bottom edge, the format bar's top edge, checkbox borders and the popover borders (my call: the design names "2 px rules" without listing them);
  - a 3 px focus ring.
- The note's colour, per-note text colour, per-selection text colours and highlights are **not shown** while it is on. They stay stored and come back when it is turned off (my call: "Any colour → white, black ink"; per-selection highlights would break 21:1 with coloured backgrounds). Highlighted text shows as plain text while it is on (my call).
- See-through (opacity below 100 %) is ignored while it is on. The note is painted fully opaque white (my call: readability over the setting). The window is not recreated.
- The Settings, Note settings and manager windows are unchanged (the switch says "notes").

### 3.2 Layout
- **Comfortable** (default): 15 px text, 16 px side padding, 32 px header.
- **Compact**: 13.5 px text, 10 px side padding, 28 px header.
- Buttons stay 28 px in both (B4).
- The text size of Compact is the default size × 0.9 (15 → 13.5), so the Default size still means something in Compact (my call). A note's own size from Note settings is used as is in both layouts (my call).

### 3.3 Default font
- Same list and command as Note settings (`list_fonts`): "System default" first, then the installed families A–Z.
- Applies to every note without its own font. A family uninstalled later falls back to the system font.

### 3.4 Default size
- Stepper − / + by 1, 10–32 px. Default 15.
- Applies to every note without its own size. The first line and headings keep their ratios, as today.

### 3.5 Reset appearance
- Sets high contrast off, Comfortable, System default font and size 15. It does not ask for confirmation, because every value is visible and can be set back (my call, as Note settings "Reset to defaults"). It never touches any note.

## 4. Storage and flow

- Four new keys in the core **settings** table, read and written only through typed core functions. No migration is needed (the table exists).
  - `appearance_high_contrast`: `"true"` or `"false"`
  - `appearance_layout`: `"comfortable"` or `"compact"`
  - `appearance_default_font`: empty (System default), or a name passing `validate_font_name`
  - `appearance_default_size`: `"10"` … `"32"`
- A stored value that is invalid reads as its default (as `parse_appearance` does for notes).
- One Tauri command reads all four (included in the existing settings read), and one per setter, or a single setter for the whole set (the builder's choice). The core validates everything.
- After a change, the shell broadcasts an `app-appearance-changed` event with the four values. Every note window applies it at once through CSS variables and a class on `.dn-note`, without reloading the editor. A note window that opens reads the current values before it is shown, so it never flashes the old look (my call).
- Backup: these are app settings, not note content. Backups (format 3) do not include them (my call: backups hold notes, as today).

## 5. Constraints

- Tokens and icons come only from `src/styles/tokens.css` and `src/components/icons.ts`. The few values B4 and "High contrast" define (13.5 / 10 / 28 px; `#ffffff`, `#000000`, 2 px, 3 px) are added as tokens.
- All SQL stays in the core. `src/ipc` is the only `invoke` caller. Validation is in Rust.
- Note windows are still created hidden, then shown.
- Tests cover:
  - the core getters and setters, including invalid stored values;
  - the CSS variables a note gets for each combination, including a note's own settings winning;
  - the Settings pane behaviour;
  - real-app checks recorded in `docs/testing/`.

## 6. Left to the builder

- Command names and whether the setters are one command or four.
- How the note applies the values (class `is-high-contrast` / `is-compact` plus variables, following `appearanceStyle`).
- Which existing borders become the 2 px rules, as long as the header, format bar, checkboxes and popovers are covered.
