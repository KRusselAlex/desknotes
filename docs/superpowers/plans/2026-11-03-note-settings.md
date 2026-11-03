# Per-note settings window Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A "Note settings" window that changes one note's font, text size, text colour, line spacing, direction, background colour, opacity and size live, saved per note.

**Architecture:** The core stores a validated `appearance` JSON object per note (migration v5, backup format 3). The shell adds commands for appearance, size, the font list and a single `note-settings` window, and creates a note window transparent only when its opacity is below 100 % (recreating it, after a save, when the slider crosses 100 %). The note window applies the appearance as CSS variables; the settings window follows the owner's design export.

**Tech Stack:** Rust (desknotes-core, rusqlite, serde), Tauri 2.12 shell, React 19 + TypeScript, Vitest + Testing Library.

**Spec:** `docs/superpowers/specs/2026-11-03-note-settings-design.md` (read it first). Design export: `/home/kouawou-alex-russel/Downloads/Milestone 1 design system complete/DeskNotes Lock Settings Reminders.dc.html`, section `data-screen-label="Note settings"` (lines ~253–300).

## Global Constraints

- All SQL in `crates/desknotes-core`; migrations appended, never edited; existing data never rewritten.
- The webview calls native commands only through `src/ipc` (ESLint enforces it).
- Window titles never show note text: the settings window's OS title is exactly `Note settings`; the window body shows no note title or text either.
- No network access; fonts come only from this computer.
- Note windows: created hidden then shown; share the manager's web process (`build_sharing_process`); platform code in `src-tauri/src/platform` / `src-tauri/src/windows`.
- Colours, sizes, icons only from `src/styles/tokens.css` and `src/components/icons.ts`; layout and copy from the design export.
- Values (spec §3): font size 10–32, default 15; text colours `#201e1d` (default), `#8c491a`, `#56633f`, `#1d4f91`; line spacing 100–200 step 5, default 145; direction `auto` (default) / `ltr` / `rtl`; opacity 80–100 step 5, default 100; font name ≤ 100 chars; default note size 300 × 280.
- Copy: opacity hint "Lowest allowed: 80 %, so text stays readable. Needs a compositor; ignored otherwise."; contrast hint "Text may be hard to read on this colour."; background image row "Background image" with "Later".
- Commits: Conventional Commits, footer `Refs: DES-19`, then `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Checks before each commit: `cargo test -p desknotes-core`, `cargo clippy --workspace --all-targets -- -D warnings`, `npm test && npm run lint && npm run typecheck` (as relevant to the task).

## Review Focus

1. A damaged `appearance` value in the database (hand-edited, or from a future version) must not make the note unreadable: the note opens with default styling.
2. Crossing 100 % opacity while text is being typed, or while the note shows "Not saved": text is saved before the window is recreated; if the save fails, the window is not recreated and the opacity change still stays saved (applied at next open).
3. Font names from the system with quotes, semicolons, very long names or duplicates: filtered out or deduplicated; a stored font that is no longer installed falls back to the system font.
4. W/H fields: empty, non-numeric, below the minimum note size or above the screen: committed values are clamped; an empty field restores the current size.
5. The settings window open for note A when A is hidden, archived, trashed or purged → it closes; "Note settings…" from note B → it switches to B without a second window.

---

### Task 1: Core — appearance model, validation, storage

**Files:**
- Modify: `crates/desknotes-core/src/model.rs` (add `Appearance`, `TextDirection`; `Note.appearance`)
- Modify: `crates/desknotes-core/src/validation.rs` (validation + constants)
- Modify: `crates/desknotes-core/src/db/migrations.rs` (v5)
- Modify: `crates/desknotes-core/src/db/notes.rs` (`NOTE_COLUMNS`, row mapping, `set_appearance`, `duplicate_note`)
- Modify: `crates/desknotes-core/src/lib.rs` (re-exports, matching existing style)
- Test: unit tests in the same files (existing pattern)

**Interfaces:**
- Produces:
  - `pub enum TextDirection { Auto, Ltr, Rtl }` — serde `rename_all = "lowercase"`.
  - `pub struct Appearance { pub font: Option<String>, pub font_size: Option<u8>, pub text_color: Option<String>, pub line_spacing: Option<u16>, pub direction: Option<TextDirection>, pub opacity: Option<u8> }` — `Default`, serde `rename_all = "camelCase"`, `deny_unknown_fields`, `skip_serializing_if = "Option::is_none"` on every field. `None` = default.
  - `pub fn validate_appearance(a: Appearance) -> CoreResult<Appearance>` — trims `font` (empty → `None`), lowercases `text_color`, refuses out-of-range values with `CoreError::Validation`.
  - `pub fn parse_appearance(raw: &str) -> CoreResult<Appearance>` (JSON → validated).
  - Constants in `validation.rs`: `FONT_SIZES: RangeInclusive<u8> = 10..=32`, `TEXT_COLORS: [&str; 4]`, `LINE_SPACINGS: RangeInclusive<u16> = 100..=200` (step 5), `OPACITIES: RangeInclusive<u8> = 80..=100` (step 5), `FONT_NAME_MAX_CHARS = 100`.
  - `Note.appearance: Appearance` (serialized as `appearance`).
  - `Db::set_appearance(&self, id: &str, appearance: &Appearance) -> CoreResult<()>` — validates, stores compact JSON, `NotFound` for unknown id; does **not** change `updated_at` (styling is not an edit) and works while the note is private-locked (reveals nothing).

- [ ] **Step 1: Write failing tests** (validation.rs)
  - `appearance_defaults_are_empty`: `serde_json::to_string(&Appearance::default()) == "{}"`.
  - `appearance_accepts_the_spec_values`: font `"  Ubuntu Mono "` → `Some("Ubuntu Mono")`; fontSize 10 and 32; textColor `"#8C491A"` → `"#8c491a"`; lineSpacing 100, 145, 200; direction `"rtl"`; opacity 80 and 100.
  - `appearance_refuses_out_of_range`: fontSize 9, 33; lineSpacing 95, 205, 147; opacity 75, 101, 83; textColor `"#ffffff"`; each is `Err`.
  - `appearance_refuses_unsafe_font_names`: `a"b`, `a;b`, `a\b`, `a\u{7}b`, 101 × `"x"` → `Err`; `""` and `"   "` → `None`.
  - `appearance_refuses_unknown_keys`: `parse_appearance(r#"{"fontSize":15,"glow":1}"#)` is `Err`.
- [ ] **Step 2:** `cargo test -p desknotes-core appearance` → FAIL (types missing).
- [ ] **Step 3:** Implement `TextDirection`, `Appearance`, constants, `validate_appearance`, `parse_appearance`.
- [ ] **Step 4: Write failing DB tests** (db/notes.rs)
  - `migration_5_gives_existing_notes_default_appearance`: a v4 database with a note (use `apply_until(.., 4)` as earlier migration tests do) → after opening, `get_note(id).appearance == Appearance::default()`; content and `updated_at` unchanged.
  - `set_appearance_round_trips_without_touching_updated_at`.
  - `set_appearance_refuses_invalid_and_unknown_note`.
  - `damaged_appearance_in_the_database_opens_with_defaults` (Review Focus 1): write `'{"fontSize":99}'` and `'not json'` with raw SQL → `get_note` is `Ok` with `Appearance::default()`; `notes_to_show` still returns the note.
  - `duplicate_keeps_appearance`.
  - `locked_private_note_keeps_its_appearance`: a private note withheld by the lock returns its `appearance` (and `set_appearance` succeeds while locked).
- [ ] **Step 5:** Run → FAIL.
- [ ] **Step 6:** Implement: migration v5 `ALTER TABLE notes ADD COLUMN appearance TEXT NOT NULL DEFAULT '{}';`; add `n.appearance` to `NOTE_COLUMNS`, map with `parse_appearance(..).unwrap_or_default()`; `set_appearance`; copy the column in `duplicate_note`.
- [ ] **Step 7:** `cargo test -p desknotes-core` and clippy → PASS.
- [ ] **Step 8:** Commit `feat(core): per-note appearance with validation (migration 5)`.

### Task 2: Core — backup format 3

**Files:**
- Modify: `crates/desknotes-core/src/backup.rs` (`BACKUP_VERSION = 3`, `BackupNote.appearance`, module doc)
- Modify: `crates/desknotes-core/src/db/backup.rs` (export and restore the column)
- Modify: `docs/backup-format.md` if it exists (grep for "privateLabel" in `docs/` to find the format doc) — add `appearance` and version 3.

**Interfaces:**
- Consumes: `Appearance`, `validate_appearance` (Task 1).
- Produces: `BackupNote.appearance: Appearance` with `#[serde(default)]`.

- [ ] **Step 1: Failing tests:** `version_3_round_trip_keeps_appearance` (db/backup.rs, export → restore → equal appearance); `version_2_file_restores_default_appearance` (backup.rs); `backup_refuses_invalid_appearance` (fontSize 99 in a v3 file → parse error naming the note, like the other validation errors).
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement; `parse_backup` runs `validate_appearance` on each note.
- [ ] **Step 4:** `cargo test -p desknotes-core` → PASS.
- [ ] **Step 5:** Commit `feat(core): backup format 3 keeps note appearance`.

### Task 3: Shell — appearance, size and font commands

**Files:**
- Create: `src-tauri/src/commands/note_settings.rs`
- Create: `src-tauri/src/platform/fonts.rs`
- Modify: `src-tauri/src/commands/mod.rs`, `src-tauri/src/platform/mod.rs`, `src-tauri/src/lib.rs` (register commands)
- Modify: `src-tauri/src/windows/mod.rs` (emit `NOTE_RESIZED`)

**Interfaces:**
- Consumes: `Db::set_appearance`, `Db::get_note`, `Db::set_window_geometry`, `windows::min_note_size`, `windows::emit_changed`, `windows::delegate_to_note`.
- Produces (Tauri commands):
  - `set_note_appearance(id: String, appearance: Appearance) -> IpcResult<()>` — saves, emits `notes-changed {id, kind:"other"}`. If the note window is open and the opacity crossed 100 % (old `< 100` ≠ new `< 100`), sends that note window the note action `"reopen"` via `delegate_to_note(app, caller_label, id, "reopen")` (the note saves itself, then calls `reopen_note`, Task 4).
  - `set_note_size(id: String, width: f64, height: f64) -> IpcResult<NoteSize>` — clamps to `[min_note_size, work area of the note's monitor]`, rounds to whole pixels, returns the size applied. Open and not collapsed → `window.set_size(LogicalSize)` (the resize event saves it). Collapsed or closed → writes the size with `set_window_geometry` keeping x/y.
  - `list_fonts() -> IpcResult<Vec<String>>` — `platform::fonts::families()`.
  - Event `NOTE_RESIZED = "note-resized"`, payload `{ id: String, width: f64, height: f64 }` (camelCase), emitted from `on_window_event` on a note's `Resized` **only to** the `note-settings` window and only when it exists.
  - `platform::fonts::families() -> Vec<String>`: Linux runs `/usr/bin/fc-list --format "%{family[0]}\n" :` (absolute path), then `parse_families(&str)`; other platforms → empty. Any failure → empty (the UI still offers "System default").
  - `pub fn parse_families(output: &str) -> Vec<String>`: trims, drops lines failing the Task 1 font-name rule, dedupes case-insensitively, sorts case-insensitively.
  - `pub fn clamp_note_size(want: (f64, f64), min: NoteSize, max: (f64, f64)) -> (f64, f64)` (pure, in `note_settings.rs`).

- [ ] **Step 1: Failing tests:** `parse_families_dedupes_sorts_and_drops_unsafe_names` (input with `"DejaVu Sans\nUbuntu\ndejavu sans\nBad\"Name\n\n  Noto Sans  \n"` → `["DejaVu Sans", "Noto Sans", "Ubuntu"]`); `clamp_note_size_keeps_inside_min_and_screen` (below min → min; above screen → screen; NaN/negative → min; fractional → rounded).
- [ ] **Step 2:** Run `cargo test -p desknotes` (the shell crate; check its name in `src-tauri/Cargo.toml`) → FAIL.
- [ ] **Step 3:** Implement the functions and commands above.
- [ ] **Step 4:** Tests + clippy → PASS.
- [ ] **Step 5:** Commit `feat: commands for note appearance, size and system fonts`.

### Task 4: Shell — the Note settings window and transparent notes

**Files:**
- Create: `src-tauri/src/windows/note_settings.rs` (window open/switch/place)
- Modify: `src-tauri/src/windows/mod.rs` (`open_note` transparency, `reopen_note`, close the settings window with its note)
- Modify: `src-tauri/src/commands/note_settings.rs` (`open_note_settings`, `reopen_note`)

**Interfaces:**
- Consumes: Task 3 commands; `build_sharing_process`, `close_note`, `open_note`, `note_label`.
- Produces:
  - `pub const NOTE_SETTINGS: &str = "note-settings"`; event `NOTE_SETTINGS_NOTE = "note-settings-note"` (payload: note id) sent to an open settings window to switch note.
  - `open_note_settings(id: String) -> IpcResult<()>` — open (or switch + focus) the window: title `"Note settings"`, inner size 400 × min(640, work-area height − 48), min 360 × 400, URL `index.html?note=<id>`, hidden-then-shown, shared web process. Placed by `pub fn place_beside(note: Rect, size: (f64, f64), area: Rect) -> (f64, f64)`: right of the note with a 12 px gap if it fits in the work area, else left, else centred in the area.
  - `reopen_note(id: String) -> IpcResult<()>` — `close_note` then `get_note` then `open_note`; emits `notes-changed {id, kind:"other"}`.
  - In `open_note`: when `note.appearance.opacity.unwrap_or(100) < 100`, `.transparent(true)`; otherwise unchanged.
  - When a note window is destroyed, hidden, archived, trashed or purged, the shell does **not** close the settings window itself; the settings window closes itself (Task 6) — keeps the rule in one place.
- Note: destroying a private note's window releases its kept-open state (`release_kept_open`); a reopen while kept open therefore locks the note. Accepted: its text is saved first.

- [ ] **Step 1: Failing tests:** `place_beside_prefers_right_then_left_then_centre` (three rects); `note_settings_url_carries_the_note_id` (`index.html?note=<uuid>`; ids are validated with `parse_note_id` before use).
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Tests + clippy → PASS; `npm run tauri build -- --no-bundle` compiles.
- [ ] **Step 5:** Commit `feat: note settings window and transparent note windows`.

### Task 5: Frontend — the note applies its appearance

**Files:**
- Modify: `src/types/note.ts` (`Appearance`, `TextDirection`, `Note.appearance`)
- Modify: `src/ipc/commands.ts` (`setNoteAppearance`, `setNoteSize`, `listFonts`, `openNoteSettings`, `reopenNote`)
- Modify: `src/ipc/events.ts` (`NoteAction` gains `"reopen"`; `onNoteResized`; `onNoteSettingsNote`)
- Create: `src/features/appearance/appearance.ts` (+ `appearance.test.ts`)
- Modify: `src/features/appearance/colors.ts` (+ test) — `contrastRatio`
- Modify: `src/features/notes/NoteWindow.tsx`, `src/styles/note.css`, `src/dev/preview.tsx` (mock new commands)
- Test: `src/features/notes/NoteWindow.test.tsx`

**Interfaces:**
- Consumes: Tasks 3–4 command names and event payloads.
- Produces:
  - `export const APPEARANCE_DEFAULTS = { fontSize: 15, textColor: "#201e1d", lineSpacing: 145, direction: "auto", opacity: 100 } as const` and `TEXT_COLORS`, ranges mirroring Task 1.
  - `export function appearanceStyle(color: string, a: Appearance): CSSProperties` — sets `--note-bg` / `--note-hd` (as `noteStyle` does today, but as `rgba(...)` with alpha `opacity/100` when below 100), `--note-ink`, `--note-font-size` (px), `--note-leading` (unitless), `--note-font` (`"<font>", var(--dn-font)` or `var(--dn-font)`).
  - `export function contrastRatio(a: string, b: string): number` (WCAG relative luminance, `#rrggbb`).
  - `note.css`: body text, title line and headings use the variables; title and heading sizes keep their ratio to 15 (`calc(var(--note-font-size) * 18 / 15)`, `16.5 / 15`); when opacity < 100 the root element sets `html, body, #root { background: transparent }` (class on `document.documentElement`, e.g. `dn-see-through`).
  - Editor root gets `dir` = `auto` | `ltr` | `rtl`.
  - ⋯ menu item `{ id: "settings", label: "Note settings…", icon: "settings" }` placed after "Always on top", calls `commands.openNoteSettings(note.id)`.
  - Note action `"reopen"`: `saveThen(() => commands.reopenNote(note.id))`; when the save fails, nothing else happens (Review Focus 2).
  - On `notes-changed` "other" for this note, the existing refresh also sets the appearance **without** reloading editor content.
  - Locked private view and collapsed strip use `appearanceStyle` too (colour/opacity only matter there).

- [ ] **Step 1: Failing tests** (`appearance.test.ts`): defaults produce the same `--note-bg` / `--note-hd` as today's `noteStyle`; opacity 80 → `--note-bg` is `rgba(255, 244, 163, 0.8)`; font `"Ubuntu Mono"` → `--note-font` `"\"Ubuntu Mono\", var(--dn-font)"`; `contrastRatio("#201e1d", "#fff4a3") > 12` and `contrastRatio("#201e1d", "#201e1d") === 1`.
- [ ] **Step 2: Failing tests** (`NoteWindow.test.tsx`): the menu shows "Note settings…" and calls `openNoteSettings`; a `notes-changed` with new appearance restyles the note and does not call `setContent`/reload (assert the editor text typed before is still there); `dir="rtl"` reaches the editor; a `"reopen"` action saves first and calls `reopenNote` only after a successful save; with a failing save `reopenNote` is not called.
- [ ] **Step 3:** Run `npm test` → FAIL.
- [ ] **Step 4:** Implement.
- [ ] **Step 5:** `npm test && npm run lint && npm run typecheck` → PASS.
- [ ] **Step 6:** Commit `feat: notes show their own font, size, colours and opacity`.

### Task 6: Frontend — the Note settings window

**Files:**
- Create: `src/features/note-settings/NoteSettingsWindow.tsx` (+ `NoteSettingsWindow.test.tsx`)
- Create: `src/styles/note-settings.css` (import in `src/main.tsx`)
- Modify: `src/app/App.tsx` (+ `App.test.tsx`) — label `note-settings` → `<NoteSettingsWindow />`, note id from `?note=`
- Modify: `src/ipc/window.ts` — `closeCurrentWindow()`, `noteIdFromUrl()` (if not present)
- Modify: `src/dev/preview.tsx` — `?w=note-settings`

**Interfaces:**
- Consumes: Task 5 IPC, types, `APPEARANCE_DEFAULTS`, `contrastRatio`, `COLOR_PRESETS`; existing `Switch`, `Segmented`, `Icon`.
- Produces: the window as in the design: header swatch of the note colour (no note text), cards **Text** (Font select: "System default" + `listFonts()`; Size −/+ 10–32; Text colour 4 swatches; Line spacing slider 100–200 step 5 with "145 %" readout; Direction segmented Automatic/LTR/RTL), **Background** (8 presets + "+" custom `<input type="color">`; contrast hint when `contrastRatio(textColor, color) < 4.5`; Opacity slider 80–100 step 5 + readout + hint; disabled "Background image · Later"), **Size** (W × H number inputs committed on Enter/blur via `setNoteSize`, using the returned size; Lock aspect ratio switch; Reset size → 300 × 280), **Behaviour** (Lock editing → `setEditLocked`; Always on top → `setAlwaysOnTop`), footer **Reset to defaults** (appearance `{}` and size 300 × 280; keeps colour and Behaviour) and **Close** (and Esc).
  - Every control applies immediately through the commands (live); the slider sends at most one `setNoteAppearance` per 100 ms while dragging and one on release.
  - Listens: `notes-changed` for its note → refresh; if the note is now hidden (`!window.visible`), archived, deleted, or `getNote` fails → `closeCurrentWindow()`; `note-resized` → update W/H fields; `note-settings-note` → switch to that note.
  - A stored font not in `listFonts()` is still shown as selected, labelled "<name> (not installed)".

- [ ] **Step 1: Failing tests** (mocked `commands`, as other window tests do):
  - renders the four cards and footer; the document title / header contain no note title (`getNote` returns title "Secret plan"; assert `queryByText(/Secret plan/)` is null).
  - Size + calls `setNoteAppearance(id, {fontSize: 16})`; stops at 32.
  - choosing text colour `#1d4f91` sends `{textColor: "#1d4f91"}`; a dark custom background (`#201e1d`) with default ink shows "Text may be hard to read on this colour."
  - W field "5000" + Enter calls `setNoteSize(id, 5000, 280)` and shows the size the command returns; an empty W + blur restores the current value and sends nothing; with Lock aspect ratio on, W 600 sends H 560 for a 300 × 280 note.
  - Reset to defaults sends `setNoteAppearance(id, {})` and `setNoteSize(id, 300, 280)` and does not call `setNoteColor`.
  - `notes-changed` where the note became archived → `closeCurrentWindow` called.
  - a stored font missing from the list shows "Old Font (not installed)".
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement, styled from the design export with tokens only (desknotes-build-from-design skill).
- [ ] **Step 4:** `npm test && npm run lint && npm run typecheck` → PASS; check `npm run dev` → `http://localhost:1420/preview.html?w=note-settings` in light and dark.
- [ ] **Step 5:** Commit `feat: note settings window`.

### Task 7: Real-app verification and docs

**Files:**
- Create: `docs/testing/m3-note-settings-verification.md`
- Modify: `CHANGELOG.md` (Unreleased → Added), `docs/design.md` if it lists per-note settings as planned.

- [ ] **Step 1:** Release build on scratch data (`XDG_DATA_HOME`), check: menu item opens the window beside the note with title "Note settings"; each control changes the note live; restart keeps everything; opacity 80 % shows the desktop through the body only, text opaque; crossing 100 % while typing keeps the text (database read-only check); W/H, lock aspect, reset size; switch note; trash note closes the window; backup export/import keeps appearance; `xwininfo` depth 32 only for see-through notes; one WebKit web process.
- [ ] **Step 2:** Record results and anything not checked.
- [ ] **Step 3:** Commit `docs: note settings verification and changelog`.
