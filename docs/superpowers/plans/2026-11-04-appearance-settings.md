# Settings → Appearance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** add the app-wide Appearance settings (high-contrast notes, compact layout, default font and size, reset) from design S4, applied live to every note.

**Architecture:**
- The core stores the four values in the settings table behind typed, validated getters and setters.
- The shell exposes them through commands and broadcasts `app-appearance-changed` after each change.
- The frontend merges them with each note's own appearance in **one** function, `effectiveAppearance`. Everything else (note CSS, the Aa popover, the Note settings window) reads that one merged value.

**Tech Stack:** Rust (`desknotes-core`, Tauri 2 commands), React 19 + TypeScript, Vitest.

**Spec:** `docs/superpowers/specs/2026-11-04-appearance-settings-design.md`

## Global Constraints

- **Branch:** work on `feat/m3-appearance`, stacked on `feat/m3-text-style` (PR #17).
- **Commits:** Conventional Commits with the footer `Refs: DES-34` and the `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` line. Never stage `.superpowers/`.
- **Project rules:**
  - no network;
  - all SQL in `crates/desknotes-core`;
  - `src/ipc` is the only `invoke` caller;
  - validation in Rust;
  - no note text in titles or logs;
  - note windows are created hidden, then shown.
- **Settings keys and values, verbatim:**
  - `appearance_high_contrast`: `"true"` or `"false"`, default false;
  - `appearance_layout`: `"comfortable"` or `"compact"`, default comfortable;
  - `appearance_default_font`: empty for System default, or a name passing `validate_font_name`;
  - `appearance_default_size`: `"10"`…`"32"`, default 15.
  An invalid stored value reads as its default.
- **High contrast:**
  - background `#ffffff`, ink `#000000`;
  - 2 px rules on the header bottom edge, the format bar top edge, checkbox borders and popover borders;
  - 3 px focus ring;
  - note colour, per-note text colour, per-selection text colours and highlights are hidden while it is on, but kept in storage;
  - see-through is painted opaque white;
  - Settings, Note settings and manager windows are unchanged.
- **Layout:**
  - Comfortable: text = default size (15), side padding 16 px, header 32 px;
  - Compact: text = default size × 0.9 (13.5), side padding 10 px, header 28 px;
  - buttons 28 px in both;
  - a note's own size from Note settings is used as is in both layouts.
- **Precedence** for font and size: selection (Aa) > note (Note settings) > app default (this feature) > built-in default.
- **Event name:** `app-appearance-changed`; its payload is the four values.
- **Copy, verbatim (S4):**
  - Settings nav order "General", "Appearance", "Privacy", "Backup", "About";
  - section title "Appearance";
  - rows "High-contrast notes", "Layout" (segments "Compact", "Comfortable"), "Default font" ("System default" first), "Default size";
  - button "Reset appearance".
- **New tokens:** `--dn-hc-bg: #ffffff`, `--dn-hc-ink: #000000`, `--dn-hc-rule: 2px`, `--dn-hc-focus: 3px`, `--dn-compact-text-scale: 0.9`, `--dn-compact-pad: 10px`, `--dn-compact-header: 28px`. Nothing else is invented.
- **Gate before every commit:** `npm test && npm run lint && npm run typecheck`, `cargo test -p desknotes-core`, `cargo clippy --workspace --all-targets -- -D warnings`.

## Review Focus

1. **Turning high contrast off restores every note exactly**, including colours, a see-through opacity, text colours and highlights. Nothing is ever written to a note. Owned by Task 3, `high contrast hides but never changes the note's own values`.
2. **A note's own font and size beat the app defaults; the defaults fill only what the note leaves unset.** Owned by Task 3, `effectiveAppearance precedence`.
3. **The Aa popover and Note settings show the merged default size.** For example, with an app default of 18 and no note size, Aa shows 18 on a paragraph and Note settings shows 18. Owned by Task 3, `popover and note settings use the effective size`.
4. **A garbage stored value**, such as `"appearance_default_size" = "99"` or a font with `;`, reads as the default and never breaks startup. Owned by Task 1, `invalid stored values read as defaults`.
5. **A note window opened after a change** shows the new look from its first paint, with no flash of the old one. Owned by Task 2/3, `note reads app appearance before it renders`.

---

### Task 1: Core — typed app appearance settings

**Files:** `crates/desknotes-core/src/model.rs`, `crates/desknotes-core/src/db/settings.rs`, `crates/desknotes-core/src/validation.rs` (only if a helper is needed)

**Interfaces:**
- Produces:
  - `pub struct AppAppearance { pub high_contrast: bool, pub layout: Layout, pub default_font: Option<String>, pub default_size: u8 }`, with `impl Default` (false, Comfortable, None, 15) and serde camelCase;
  - `pub enum Layout { Comfortable, Compact }`, serialized lowercase;
  - `Db::app_appearance(&self) -> CoreResult<AppAppearance>`, which never errors on bad stored values and falls back per field;
  - `Db::set_app_appearance(&self, a: AppAppearance) -> CoreResult<AppAppearance>`, which validates (size 10–32, font via `validate_font_name`, so blank means None), stores all four keys in one transaction and returns the normalised value;
  - constants for the four keys in `settings.rs`, next to `MIN_NOTE_SIZE`.

- [ ] **Step 1: Write the failing tests in `settings.rs` tests.**
  - `app_appearance_defaults_when_unset`.
  - `set_and_read_back`: high contrast true, Compact, "Amiri", 18.
  - `set_refuses_out_of_range_size`: 9 and 33 are refused.
  - `set_refuses_unsafe_font`: `a;b` is refused.
  - `blank_font_means_system_default`: `"  "` becomes None.
  - `invalid stored values read as defaults`: write raw `"99"`, `"maybe"`, `"wide"` and `"a;b"` with `set_setting`; the getter returns the defaults for those fields only.
- [ ] **Step 2: Run them; they should fail.** Command: `cargo test -p desknotes-core settings`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them; they should pass.** Command: `cargo test -p desknotes-core`, then clippy.
- [ ] **Step 5: Commit** as `feat(core): app-wide appearance settings`.

### Task 2: Shell — commands and live broadcast

**Files:** `src-tauri/src/commands/settings.rs`, `src-tauri/src/lib.rs` (register), `src-tauri/src/windows/mod.rs` (event constant), `src/ipc/commands.ts`, `src/ipc/events.ts`, `src/types/*.ts`

**Interfaces:**
- Consumes: Task 1's `Db::app_appearance` and `Db::set_app_appearance`.
- Produces:
  - `#[tauri::command] get_app_appearance(state) -> IpcResult<AppAppearance>`;
  - `#[tauri::command] set_app_appearance(app, state, appearance: AppAppearance) -> IpcResult<AppAppearance>`, which saves and then emits `APP_APPEARANCE_CHANGED` (`"app-appearance-changed"`) to all windows with the normalised value;
  - `SettingsView` gains `app_appearance: AppAppearance`.
- Produces, TS:
  - `type AppAppearance = { highContrast: boolean; layout: "comfortable" | "compact"; defaultFont: string | null; defaultSize: number }`;
  - `APP_APPEARANCE_DEFAULTS`;
  - `commands.getAppAppearance()` and `commands.setAppAppearance(a)`;
  - `onAppAppearanceChanged(handler)`.
- Capabilities: note windows can already listen to events. Check that `default.json` and `note-settings.json` cover the new commands for the windows that call them: the settings window sets them; notes, the note-settings window and the manager read them.

- [ ] **Step 1: Write the failing tests.**
  - Rust unit test of the command's validation path, following existing `commands/settings.rs` tests if any. Otherwise rely on the core tests and add an ipc test in `src/ipc` following the existing ipc tests, which check command names and args.
  - TS test that `onAppAppearanceChanged` listens on `"app-appearance-changed"`.
- [ ] **Step 2: Run them; they should fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them; they should pass.** Run the full gate.
- [ ] **Step 5: Commit** as `feat(settings): commands and live event for app appearance`.

### Task 3: Notes follow the app appearance

**Files:**
- `src/features/appearance/appearance.ts` (+ test)
- `src/features/notes/NoteWindow.tsx` (+ test)
- `src/features/notes/textStyle.ts` and `TextStylePopover.tsx`, only to take the merged value
- `src/features/note-settings/NoteSettingsWindow.tsx` (+ test)
- `src/styles/note.css`, `src/styles/tokens.css`

**Interfaces:**
- Consumes: Task 2's TS types, commands and event.
- Produces:
  - `export function effectiveAppearance(note: Appearance, app: AppAppearance): Appearance`. It fills `font` and `fontSize` from the app defaults only when the note has none; for Compact, the filled size is `defaultSize × 0.9`, unrounded (13.5). A note's own values are returned unchanged.
  - `export function appClasses(app: AppAppearance): string`, which returns `" is-high-contrast"` and/or `" is-compact"`.
  - `export function useAppAppearance(): AppAppearance | null`. It loads once with `getAppAppearance`, then follows `onAppAppearanceChanged`.
  - `appearanceStyle(color, effectiveAppearance(note, app))` stays the single place that builds note CSS variables. High contrast is done in CSS on `.dn-note.is-high-contrast` (overriding `--note-bg`, `--note-hd`, `--note-ink`, mark colours and highlights), not by changing values.
- NoteWindow renders nothing (as while the note loads) until **both** the note and the app appearance are loaded, so a window opened after a change never shows the old look.
- The Aa popover gets the merged appearance, so its size fallback is the effective default.
- The Note settings window shows the merged default (its "Size" reads the app default when the note has none) and still stores only the note's own values.

- [ ] **Step 1: Write the failing tests.**
  - `effectiveAppearance precedence`:
    - a note `{fontSize: 20, font: "Amiri"}` with app `{defaultSize: 18, defaultFont: "DejaVu Sans"}` → 20 and Amiri;
    - a note `{}` → 18 and DejaVu Sans;
    - Compact with note `{}` → 16.2;
    - Compact with note `{fontSize: 20}` → 20.
  - `appClasses` covers all four combinations.
  - `high contrast hides but never changes the note's own values`:
    - render NoteWindow with a peach, 80 %-opacity note and app `highContrast: true`;
    - the root has `is-high-contrast`, and its inline variables are those of the note's own values;
    - turning it off via the event removes the class;
    - no save command was called.
  - `note reads app appearance before it renders`: with the app appearance promise pending, nothing is rendered; after it resolves, the note renders with the classes.
  - `popover and note settings use the effective size`: with app `defaultSize: 18` and note `{}`, the Aa popover shows 18 on a paragraph, and the Note settings Size shows 18.
  - A CSS test is not possible in jsdom. Instead, add the class checks and a preview state (Task 4) for the visual check.
- [ ] **Step 2: Run them; they should fail.**
- [ ] **Step 3: Implement.**
  - Add the tokens.
  - Add the `.dn-note.is-high-contrast` and `.dn-note.is-compact` rules in `note.css`. Compact uses the tokens for padding and header height. High contrast covers the 2 px rules on the header bottom, the format bar top, checkboxes and popovers, the 3 px focus ring, and hides marks' colours and highlights with `!important` only where inline mark styles require it.
- [ ] **Step 4: Run them; they should pass.** Run the full gate.
- [ ] **Step 5: Commit** as `feat(notes): follow high contrast, layout and default font and size`.

### Task 4: The Appearance pane (S4)

**Files:** `src/features/settings/AppearancePane.tsx` (new, + test), `src/features/settings/SettingsWindow.tsx` (+ test), `src-tauri/src/windows/mod.rs` (`settings_section` accepts `"appearance"`), `src/styles/*.css` as needed, `src/dev/preview.tsx` (preview states: `?w=settings&section=appearance` and a note with `&hc=1` / `&compact=1`)

**Interfaces:**
- Consumes: Task 2's commands and `commands.listFonts()`.
- Produces: `export function AppearancePane({ value, onChange }: { value: AppAppearance; onChange: (a: AppAppearance) => void })`. SettingsWindow owns saving via `setAppAppearance` and shows an error the way the other panes do.
- Layout and copy follow S4. Reuse `Switch`, `Segmented` and the font `<select>` and stepper patterns from `NoteSettingsWindow.tsx`. The stepper runs 10–32 and is disabled at the limits. "Reset appearance" sends the defaults.

- [ ] **Step 1: Write the failing tests.**
  - The nav order is General, Appearance, Privacy, Backup, About.
  - `?section=appearance` opens Appearance.
  - The switch toggles high contrast.
  - Choosing Compact saves the layout.
  - The font select lists "System default" then the installed fonts, and choosing one saves it.
  - The stepper stops at 10 and 32.
  - Reset appearance saves the defaults.
  - A failed save shows the error and keeps the old value.
- [ ] **Step 2: Run them; they should fail.**
- [ ] **Step 3: Implement.** Then compare the preview with S4 in light and dark.
- [ ] **Step 4: Run them; they should pass.** Run the full gate.
- [ ] **Step 5: Commit** as `feat(settings): Appearance pane (design S4)`.

### Task 5: Real-app verification and docs

**Files:** `docs/testing/m3-appearance-verification.md`, `CHANGELOG.md`

- [ ] **Step 1: Build a release binary and run it on scratch data**, using the owner's agreement to quit their DeskNotes.
- [ ] **Step 2: Check:**
  - every control in the real Settings window;
  - notes change live, including a note opened after the change;
  - high contrast on a peach see-through note, then off, so the note is back exactly;
  - Compact against B4;
  - a note with its own font and size keeps them;
  - everything survives a restart.
- [ ] **Step 3: Write the testing doc and the CHANGELOG entry, then commit** as `docs: appearance verification and changelog`.
