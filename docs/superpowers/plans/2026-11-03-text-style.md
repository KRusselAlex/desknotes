# Aa Text-Style Popover Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Format selected text in a note (font, size, weight, text colour, highlight, alignment, case, undo/redo) from an "Aa" popover at the end of the bottom formatting bar, as in the owner's design N14.

**Architecture:** Formatting is stored as Tiptap marks and node attributes inside the existing `content_json`, with no migration. The Rust allowlist accepts exactly the new marks and values. Three MIT Tiptap packages plus one local extension produce them. Their HTML parsing and the existing `sanitizeDoc` drop anything outside the allowed sets, so pasted web text cannot make a note unsavable. A new `TextStylePopover` component, opened from `FormatBar`, drives the editor commands.

**Tech Stack:** Rust (`desknotes-core`, serde_json), React 19 + TypeScript, Tiptap 3.32.2, Vitest + Testing Library.

**Spec:** `docs/superpowers/specs/2026-11-03-text-style-design.md`

## Global Constraints

- Work on branch `feat/m3-text-style` (stacked on `feat/m3-note-settings`, PR #16). Conventional Commits, footer `Refs: DES-32` plus the Co-Authored-By line.
- No network, accounts or telemetry. Fonts come only from the local `list_fonts` command (DES-19).
- Content is validated Tiptap JSON, never HTML. All SQL stays in `crates/desknotes-core`. `src/ipc` is the only `invoke` caller.
- Every new mark or attribute goes into `crates/desknotes-core/src/validation.rs` **and** `tests/fixtures/rich-doc.json` in the same change.
- Allowed values, verbatim from the spec:
  - text colours `#201e1d`, `#8c491a`, `#56633f`, `#1d4f91`, `#7a1b14`, `#5b3a8c`;
  - highlight colours `#ffe36e`, `#ffc6a5`, `#ccdbb2`, `#bcd9ff`;
  - font sizes `"10px"`…`"32px"`, whole numbers only;
  - font weights `"300"`, `"400"`, `"500"`, `"600"`, labelled Light, Regular, Medium, Semibold;
  - `textAlign` on `paragraph` and `heading`: `"left"`, `"center"`, `"right"` or null;
  - `fontFamily` must pass the DES-19 font-name rule (≤ 100 characters; no control characters, `"`, `\` or `;`).
- New packages, all exactly `3.32.2`: `@tiptap/extension-text-style`, `@tiptap/extension-highlight`, `@tiptap/extension-text-align`.
- Colours, sizes and icons come only from `src/styles/tokens.css` and `src/components/icons.ts`. The 10 N14 colours are added to `tokens.css` as tokens. Copy, verbatim:
  - labels "Font", "Size", "Text", "Highlight", "System default";
  - button text "AB" and "ab";
  - `aria-label`s "Text style", "Align left", "Align centre", "Align right", "Undo", "Redo", "No highlight";
  - titles "Undo (Ctrl+Z)" and "Redo (Ctrl+Shift+Z)";
  - overflow menu item "Text style…".
- Window titles, notifications and logs never contain note text.
- Gate before every commit: `npm test && npm run lint && npm run typecheck`, `cargo test -p desknotes-core`, `cargo clippy --workspace --all-targets -- -D warnings`.

## Review Focus

1. **Pasted web text** with an arbitrary `color`, `font-size: 13.5px`, `font-family: "x"; …`, `background-color` or `text-align: justify` must paste as plain text, without those styles, and the note must still save. Owned by Task 2: `drops pasted styles outside the allowed sets`.
2. **Old notes:** opening a note saved before this change (no `textAlign`, no new marks) must not mark it as edited or save it. Owned by Task 2: `old documents serialize unchanged after a load`.
3. **Case change over mixed formatting:** "**Ab** c" with bold on "Ab", turned to UPPERCASE, keeps bold on exactly "AB", and one undo restores it. Owned by Task 3: `upper case keeps marks per character`.
4. **Mixed selection:** a selection spanning two fonts or sizes shows "System default" and the size at the start of the selection, never crashes or shows "NaN". Owned by Task 3: `textStyleState on a mixed selection`.
5. **Size stepper at its limits:** − at 10 and + at 32 are disabled, and nothing outside 10–32 is ever stored. Owned by Task 4: `size stepper stops at the limits`.

---

### Task 1: Core allowlist for text style, highlight and alignment

**Files:**
- Modify: `crates/desknotes-core/src/validation.rs`
- Modify: `docs/backup-format.md` (list the new marks under content; no new format number)

**Interfaces:**
- Produces:
  - `pub const TEXT_STYLE_COLORS: [&str; 6]`
  - `pub const HIGHLIGHT_COLORS: [&str; 4]`
  - `pub const FONT_WEIGHTS: [&str; 4]`
  - `validate_doc` accepts the spec §5 table and refuses everything else.

- [ ] **Step 1: Write the failing tests** in the `tests` module of `validation.rs`. Use a helper `fn doc_with_marks(marks: serde_json::Value) -> Value` that wraps one text node in a paragraph, and `fn doc_with_align(kind: &str, align: Value) -> Value`.
  - `text_style_accepts_the_spec_values`: each of the 6 colours; `fontSize` `"10px"`, `"15px"` and `"32px"`; each of the 4 weights; `fontFamily` `"Amiri"`; every attribute null at once. All `Ok`.
  - `text_style_refuses_other_values`: each of these is `Err`:
    - `color` `"#000000"`, `"red"`, `"#201E1D; x"`;
    - `fontSize` `"9px"`, `"33px"`, `"15.5px"`, `"15"`, `"15pt"` and the number `15`;
    - `fontWeight` `"700"`, `"bold"` and the number `400`;
    - `fontFamily` `"a;b"`, `"a\"b"` and 101 characters;
    - an unknown attribute `lineHeight`.
  - `highlight_accepts_only_the_four_colours`: the 4 colours are `Ok`. `"#ffff00"`, no `attrs`, `color` null and an extra attribute are `Err` (my call: a highlight always has one of the 4 colours).
  - `text_align_values`: `left`, `center`, `right` and null on a paragraph and on a heading (with `level: 2`) are `Ok`. `"justify"` and `"start"` are `Err`.
  - Colour comparison is case-insensitive (`"#1D4F91"` is `Ok`), matching `validate_color`.

- [ ] **Step 2: Run them and confirm they fail.** Run `cargo test -p desknotes-core validation`. Expected: the new tests FAIL with "unsupported mark".

- [ ] **Step 3: Implement.**
  - Add `"textStyle"` and `"highlight"` to `ALLOWED_MARKS` and update its doc comment.
  - Add a `validate_text_style(attrs)` / `validate_highlight(attrs)` branch to `validate_mark`, in the same shape as the `link` branch.
  - Add a `textAlign` check to `validate_node` for `paragraph` and `heading`. `textAlign` on any other node type is refused.
  - `fontFamily` reuses `validate_font_name`. Note that it trims, so `" Amiri "` passes and is not rewritten here.

- [ ] **Step 4: Run them and confirm they pass.** Run `cargo test -p desknotes-core`. Expected: all pass. `shared_fixture_is_valid` still passes because the fixture is unchanged until Task 2.

- [ ] **Step 5: Commit.** Run `git commit -m "feat(core): allow text style, highlight and alignment in note content"` with the footer.

### Task 2: Editor extensions, paste filtering and the shared fixture

**Files:**
- Modify: `package.json`, `package-lock.json` (`npm install --save-exact` for the three packages at 3.32.2)
- Create: `src/features/notes/textStyle.ts` (allowed sets and predicates)
- Modify: `src/features/notes/extensions.ts`
- Modify: `tests/fixtures/rich-doc.json`
- Test: `src/features/notes/extensions.test.ts`, `src/features/notes/textStyle.test.ts`
- Modify: `docs/design.md` §2 (one row per new package: version, MIT, purpose)

**Interfaces:**
- Consumes: the Task 1 values.
- Produces, in `textStyle.ts`:
  - `export const TEXT_STYLE_COLORS: readonly string[]` (6)
  - `export const HIGHLIGHT_COLORS: readonly string[]` (4)
  - `export const FONT_WEIGHTS: readonly { value: "300"|"400"|"500"|"600"; label: string }[]`
  - `export function isAllowedFontSize(v: unknown): v is string`
  - `export function isAllowedFontFamily(v: unknown): v is string`
  - `export function isAllowedTextColor(v: unknown): v is string`
  - `export function isAllowedHighlight(v: unknown): v is string`
  - `export function isAllowedAlign(v: unknown): v is "left"|"center"|"right"`
  - All of these are case-insensitive for colours and return the lower-case form where relevant.
  - `createExtensions()` now also registers:
    - `TextStyle`, `Color`, `FontFamily`, `FontSize`;
    - a local `FontWeight` extension adding a `fontWeight` global attribute to `textStyle` (rendered as `font-weight`);
    - `Highlight.configure({ multicolor: true })`;
    - `TextAlign.configure({ types: ["heading", "paragraph"], alignments: ["left", "center", "right"], defaultAlignment: null })`.
  - Editor commands in use from here on: `setColor`, `unsetColor`, `setFontFamily`, `unsetFontFamily`, `setFontSize`, `unsetFontSize`, `setHighlight({color})`, `unsetHighlight`, `setTextAlign`, `unsetTextAlign`, plus local `setFontWeight(value)` and `unsetFontWeight()`.

- [ ] **Step 1: Write the failing tests.**
  - `textStyle.test.ts`: each predicate accepts the spec values and refuses the Task 1 refusal list. Mirror those cases; `isAllowedFontSize("15.5px") === false`.
  - `extensions.test.ts`:
    - `round-trips the shared fixture exactly` (existing) — passes once the fixture has the new content.
    - `drops pasted styles outside the allowed sets`:
      - `editor.commands.setContent('<p style="text-align:justify"><span style="color:#ff0000;font-size:13.5px;font-family:&quot;x&quot;;font-weight:700">a</span><mark data-color="#123456" style="background-color:#123456">b</mark></p>')`;
      - then `serializeDoc(editor.getJSON())` contains no `#ff0000`, `13.5px`, `700`, `#123456` or `justify`;
      - and the text `ab` is kept.
    - `keeps pasted styles inside the allowed sets`: `<span style="color:#1d4f91;font-size:18px">a</span>` keeps both.
    - `sanitizeDoc removes stray values from stored JSON`: a doc with
      - a `textStyle` `{ color: "#ff0000", fontSize: "18px" }` becomes `{ color: null, fontSize: "18px" }`, or the mark is removed when every attribute ends up null;
      - a `highlight` with `#123456` loses the mark;
      - `textAlign: "justify"` becomes null.
    - `old documents serialize unchanged after a load`:
      - load `{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"x"}]}]}`;
      - serialize, set the same content again, serialize again;
      - both strings are equal, and `NoteWindow` does not save on open. Add the assertion to `NoteWindow.test.tsx` next to the existing "opening a note does not save" test if it exists; otherwise add `opening an old note does not save` there.

- [ ] **Step 2: Run them and confirm they fail.** Run `npx vitest run src/features/notes`. Expected: FAIL (missing module / marks unknown).

- [ ] **Step 3: Implement.**
  - Install the packages.
  - Write `textStyle.ts`.
  - Extend `Color`, `FontFamily`, `FontSize`, `Highlight` and `TextAlign` with `parseHTML` wrappers that return null for values the predicates refuse.
  - Extend `sanitizeDoc` to clean `textStyle` and `highlight` marks and `textAlign`, in the same style as its link handling.
  - Update `tests/fixtures/rich-doc.json`:
    - one paragraph with a `textStyle` mark carrying all four attributes;
    - one `highlight` with `#ffe36e`;
    - `textAlign: "center"` on one paragraph.
  - Every other paragraph and heading gains `"textAlign": null` if Tiptap's `getJSON()` emits it. Match `getJSON()` output exactly, since the round-trip test compares with `toEqual`.

- [ ] **Step 4: Run the tests and confirm they pass.** Run `npm test && cargo test -p desknotes-core`. Expected: all pass, including the Rust `shared_fixture_is_valid`, which now checks the new fixture.

- [ ] **Step 5: Commit.** Run `git commit -m "feat(editor): text style, highlight and alignment marks with paste filtering"` with the footer.

### Task 3: Text-style editor logic (state and case change)

**Files:**
- Modify: `src/features/notes/textStyle.ts`
- Test: `src/features/notes/textStyle.test.ts`

**Interfaces:**
- Consumes:
  - Task 2's extensions and predicates;
  - `Appearance` and `APPEARANCE_DEFAULTS` from `src/features/appearance/appearance.ts`.
- Produces:
  - `export interface TextStyleState { fontFamily: string | null; fontSize: number; fontWeight: "300"|"400"|"500"|"600"; color: string; highlight: string | null; align: "left"|"center"|"right"; canUndo: boolean; canRedo: boolean; hasSelection: boolean }`
  - `export function textStyleState(editor: Editor, appearance: Appearance): TextStyleState`. It gives effective values (spec §3):
    - `fontFamily` is null when unset or mixed;
    - `fontSize` is the start of the selection's own size, else `appearance.fontSize ?? 15`;
    - `color` is the own colour, else the note's text colour;
    - `align` is the stored value, else `"right"` when `appearance.direction === "rtl"`, else `"left"`.
  - `export function changeCase(editor: Editor, to: "upper" | "lower"): boolean`. It does nothing and returns false for an empty selection. It is one transaction (one undo step), replaces each text node's slice inside the selection with `schema.text(newText, node.marks)`, and maps positions through the transaction so the selection still covers the changed text. Case comes from `toLocaleUpperCase()` / `toLocaleLowerCase()`.
  - `export function setTextColor(editor: Editor, color: string, appearance: Appearance): void`. It calls `unsetColor` when `color` equals the note's text colour (spec §3.4); otherwise it calls `setColor`.
  - `export function setAlign(editor: Editor, align: "left"|"center"|"right", appearance: Appearance): void`. It calls `unsetTextAlign` when `align` is the default for the note's direction (spec §3.6); otherwise it calls `setTextAlign`.
  - `export function setWeight(editor: Editor, weight: "300"|"400"|"500"|"600"): void`. `"400"` calls `unsetFontWeight`.

- [ ] **Step 1: Write the failing tests.** Use a real `Editor` with `createExtensions()`, as `extensions.test.ts` does.
  - `upper case keeps marks per character`:
    - content: `<p><strong>Ab</strong> c</p>`; select all; `changeCase(editor, "upper")`;
    - JSON text nodes are `AB` (bold) and ` C`;
    - `editor.commands.undo()` restores `Ab` and ` c`.
  - `lower case of a partial selection`: in `HELLO`, select positions 2–4 (`EL`); the result is `HelLO`.
  - `changeCase with no selection returns false and changes nothing`.
  - `changeCase handles letters that change length`: `ß` to upper gives `SS`, and the selection still covers it.
  - `textStyleState on a mixed selection`: two runs, `fontFamily` "Amiri" and none, both selected. The result has `fontFamily` null and a finite `fontSize`.
  - `textStyleState uses the note appearance as default`: with `{ fontSize: 20, textColor: "#1d4f91", direction: "rtl" }` and plain text, the result is `fontSize` 20, `color` `#1d4f91`, `align` `"right"`.
  - `setTextColor with the note colour removes the own colour`.
  - `setAlign to the default removes textAlign` (LTR + left gives null; RTL + right gives null; RTL + left gives `"left"`).
  - `setWeight 400 removes fontWeight`.

- [ ] **Step 2: Run them and confirm they fail.** Run `npx vitest run src/features/notes/textStyle.test.ts`. Expected: FAIL (functions not exported).

- [ ] **Step 3: Implement the functions above in `textStyle.ts`.**

- [ ] **Step 4: Run them and confirm they pass.** Run `npm test`. Expected: PASS.

- [ ] **Step 5: Commit.** Run `git commit -m "feat(editor): text-style state and case change"` with the footer.

### Task 4: The Aa popover and its place in the bar

**Files:**
- Create: `src/features/notes/TextStylePopover.tsx`
- Test: `src/features/notes/TextStylePopover.test.tsx`
- Modify: `src/features/notes/FormatBar.tsx`, `src/features/notes/NoteWindow.tsx` (pass `appearance`), `src/styles/note.css`, `src/styles/tokens.css`, `src/dev/preview.tsx` (a preview state with the popover open)

**Interfaces:**
- Consumes:
  - Task 3's `textStyleState`, `changeCase`, `setTextColor`, `setAlign`, `setWeight`;
  - Task 2's lists;
  - `commands.listFonts()` from `src/ipc/commands.ts`.
- Produces:
  - `export function TextStylePopover({ editor, appearance, onClose }: { editor: Editor; appearance: Appearance; onClose: () => void })`
  - `FormatBar` gains the prop `appearance: Appearance`.
  - `Open` gains `"textStyle"`.

Layout, top to bottom (N14):
1. "Font" label and a `<select>`: "System default" first, then `listFonts()` results. The fonts are fetched once per note window and cached at module level; a failure leaves only "System default".
2. "Size" label, then a row with the −/value/+ stepper and the weight `<select>`.
3. "Text" label and a 6-swatch radiogroup.
4. "Highlight" label, then a radiogroup: the × swatch (`aria-label` "No highlight", icon `close` 11) followed by 4 swatches.
5. A button row: 3 align buttons (`aria-pressed`), a divider, AB, ab (disabled without a selection), a divider, Undo, Redo (disabled when they can't run).

Behaviour:
- Every control uses `onMouseDown={e => e.preventDefault()}`, like `Tool`, so the selection is kept.
- Choosing a value keeps the popover open.
- Esc or a click outside calls `onClose`, and `FormatBar` then focuses the editor (existing `close`).
- Arrow keys move between swatches inside each radiogroup, as `ColorPopover` does.
- State is read with `useEditorState` from `textStyleState`.
- Swatch and token names in `tokens.css`: `--dn-text-ink`, `--dn-text-brown`, `--dn-text-olive`, `--dn-text-blue`, `--dn-text-red`, `--dn-text-violet`, `--dn-highlight-yellow`, `--dn-highlight-peach`, `--dn-highlight-sage`, `--dn-highlight-sky`. These are the N14 hex values in spec order.
- In `FormatBar`:
  - the Aa button (`dn-tool`, text "Aa", `aria-label` "Text style", `aria-haspopup="dialog"`, `aria-expanded`, `data-popover-toggle`) comes after Link, behind a `dn-format-divider` span, when not narrow;
  - when narrow, the overflow menu gains `{ id: "textStyle", label: "Text style…", icon: "type" if it exists in icons.ts, else no icon }`, which opens the same popover.

- [ ] **Step 1: Write the failing tests** in `TextStylePopover.test.tsx`. Use a real editor with `createExtensions()` and mock `commands.listFonts` to resolve `["Amiri", "DejaVu Sans"]`.
  - `lists System default then the installed fonts`.
  - `choosing a font sets it on the selection` (JSON has `fontFamily: "Amiri"`); `System default` removes it.
  - `size stepper stops at the limits`:
    - with own size 32, + is disabled; with 10, − is disabled;
    - pressing + from the note default 15 stores `"16px"`.
  - `text colour swatch sets the colour and rings it` (`aria-checked`).
  - `No highlight removes the highlight`.
  - `align centre presses Align centre`.
  - `AB is disabled without a selection`.
  - `Undo is disabled on a fresh editor`.
  - `Escape calls onClose`.
  - `keeps the popover open after a choice`.
  - In `FormatBar` (add to `NoteWindow.test.tsx` or a new `FormatBar.test.tsx`):
    - `Aa opens the Text style popover` and sets `aria-expanded="true"`;
    - `narrow bar offers Text style… in the overflow menu`.

- [ ] **Step 2: Run them and confirm they fail.** Run `npx vitest run src/features/notes`. Expected: FAIL.

- [ ] **Step 3: Implement the component, the bar changes, the CSS and the tokens.**
  - The popover is absolutely positioned above the format bar, inside `.dn-note`. Width `min(260px, 100% - 16px)`, `max-height` the space above the bar, `overflow-y: auto`. Colours and radii come only from tokens.
  - Add a `?w=note&textStyle=1` style preview state in `src/dev/preview.tsx`, following how the other preview states are written.

- [ ] **Step 4: Run the full gate and confirm it passes.** Run `npm test && npm run lint && npm run typecheck`. Expected: all pass. Then compare `npm run dev` → `http://localhost:1420/preview.html?w=note` (popover open) with the N14 export, in light and dark.

- [ ] **Step 5: Commit.** Run `git commit -m "feat(notes): Aa text-style popover (design N14)"` with the footer.

### Task 5: Real-app verification and docs

**Files:**
- Create: `docs/testing/m3-text-style-verification.md`
- Modify: `CHANGELOG.md` (Unreleased → Added: one entry)

- [ ] **Step 1: Build and run with scratch data.** Run `npm run tauri build -- --no-bundle`, then the `desknotes-verify-ubuntu` skill with `DESKNOTES_TEST_DATA` (never the owner's data; quit the owner's DeskNotes only with their agreement).
- [ ] **Step 2: Check in the real app** and record each result:
  - the Aa popover matches N14;
  - each control changes the text;
  - the formatting survives a restart and Duplicate;
  - the narrow overflow item works;
  - a note with the new formatting saves (the database holds the marks);
  - a paste from a web page with styles saves.
  Keyboard-only items that can't be driven under Wayland are listed as owner checks.
- [ ] **Step 3: Write the testing doc and the CHANGELOG entry, then commit.** Run `git commit -m "docs: text-style verification and changelog"` with the footer.
