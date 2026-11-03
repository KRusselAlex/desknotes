# Aa text-style popover — design (Milestone 3, DES-32)

Date: 2026-11-03 · Jira: DES-32 (parent DES-4)
Sources: owner's Claude Design export "DeskNotes Note Window" → **M3 · N14 Aa text-style
popover** ("All Milestone 3 additions in one popover, so the bar never grows. Window shown
at 320 × 380") and N12 (narrow bar, "Text style…" in the overflow menu);
`docs/ui-design-brief.md` "Milestone 3 additions"; `docs/design.md` §6 (M3 scope).

The owner said "continue" instead of answering the question round. Everything that is not
in the design export or the brief is marked **(my call)** so the owner can check those.

## 1. Intent

Make part of a note stand out — a red deadline, a highlighted phone number, a bigger
heading line in another font, a centred title — without leaving the note and without the
formatting bar growing. Note settings (DES-19) styles the **whole note**; this popover styles
the **selected text** (or the paragraph the cursor is in, for alignment).

## 2. Goals, non-goals, anti-goals

Goals
- An **Aa** button at the end of the bottom formatting bar, after Link and a thin divider,
  opening the **Text style** popover above the bar, laid out as N14:
  1. **Font** dropdown, then **Size** stepper (− 15 +) and **weight** dropdown (Regular).
  2. **Text** colour: 6 swatches.
  3. **Highlight**: "none" (×) and 4 swatches.
  4. A row of buttons: **Align left / Align centre / Align right**, divider, **AB** / **ab**,
     divider, **Undo** / **Redo**.
- Every change applies to the note at once, is saved by the normal autosave and is undoable.
- Formatting survives restarts, Duplicate, backup and restore, and copy/paste inside DeskNotes.

Non-goals
- Custom (free) colours for text or highlight: only the design's swatches.
- Paragraph spacing, indentation, justify, sub/superscript.
- A second toolbar row; the bar keeps its Milestone 1 tools.

Anti-goals (a failure even if it "works")
- **A note that can no longer be saved** because pasted web text brought a colour, font or
  size the core refuses (the 0.2.0 pasted-link bug). Pasted formatting outside the allowed
  values is dropped, keeping the text.
- Any style value reaching the page that the core did not check (no free CSS in notes).
- Losing the selection or the typing position when using the popover.
- Note text in any window title, notification or log line.

## 3. What each control does

"Effective" means what the text actually shows: its own formatting if it has some, otherwise
the note's Note settings value, otherwise the app default.

### 3.1 Font
- List: first item **"System default"**, then the font families installed on this computer
  A–Z — the same list and the same `list_fonts` command as Note settings (DES-19).
- Choosing a family sets it on the selection; "System default" removes the selection's own
  font so it follows the note's font from Note settings (my call: the label stays "System
  default" as in the design even when the note has its own font).
- The closed dropdown shows the selection's own font, or "System default" when it has none or
  the selection mixes fonts (my call).
- A family later uninstalled falls back to the note's font (the browser does this).

### 3.2 Size
- Stepper − / + by 1 px, 10–32 px (the Note settings range). Shows the effective size of the
  start of the selection (my call). Pressing − or + sets that size on the selection.
- A selection's own size is fixed: changing the note's size in Note settings later does not
  change it (my call; the alternative, sizes relative to the note, is not what "15" in the
  design says).

### 3.3 Weight
- Dropdown with **Light (300), Regular (400), Medium (500), Semibold (600)** (my call: the
  design shows only "Regular"; **Bold** stays the B button and the `bold` mark, so the two
  never disagree). Regular removes the selection's own weight.
- A font without that weight shows the nearest one the system has; nothing is promised beyond
  that (my call).

### 3.4 Text colour
- Six swatches, from the design: `#201e1d`, `#8c491a`, `#56633f`, `#1d4f91`, `#7a1b14`,
  `#5b3a8c`. The current colour is ringed, like the note colour picker (N8).
- Choosing the colour the note already uses for its text (Note settings → Text colour)
  removes the selection's own colour instead of storing a copy (my call: keeps the text
  following the note if the note colour changes later).

### 3.5 Highlight
- **×** (no highlight), then four swatches from the design: `#ffe36e`, `#ffc6a5`, `#ccdbb2`,
  `#bcd9ff`. The current one is ringed.

### 3.6 Alignment
- Applies to every paragraph or heading the selection touches: left, centre, right. List items
  and checklist items are paragraphs inside the list, so they align too.
- Pressed state: the stored alignment; when a paragraph has none, **Align left** shows pressed,
  or **Align right** when the note's direction (Note settings) is RTL (my call).
- Choosing the alignment that is already the default for that state removes the stored value
  (my call), so "Automatic" direction keeps working per paragraph.

### 3.7 Case (AB / ab)
- **AB** makes the selected letters UPPERCASE, **ab** lowercase. This changes the **text
  itself** (not a display style), so search, the title and copying see the new case
  (my call; the brief says "UPPERCASE / lowercase").
- Formatting on the changed letters is kept. Disabled when nothing is selected. One Ctrl+Z
  undoes it.

### 3.8 Undo / Redo
- The editor's existing history (Ctrl+Z, Ctrl+Shift+Z). Each button is disabled when there is
  nothing to undo or redo.

### 3.9 With no selection
- Font, size, weight, colour and highlight apply to what is typed next at the cursor (the
  editor's usual behaviour for marks). Alignment applies to the cursor's paragraph. Case is
  disabled.

## 4. The popover

- Opens upward from the Aa button, inside the note window, about 260 px wide (N14); in a note
  narrower than that it uses the note's width minus the margins (my call). If the note is too
  short for it, the popover scrolls (my call).
- The Aa button shows as pressed while open (`aria-expanded`). The editor keeps its selection:
  every control prevents the editor losing focus, like the existing bar tools.
- Closes with Esc, a click outside, or Aa again; focus returns to the text. Choosing a value
  does **not** close it, so several changes can be made in a row (my call).
- Keyboard: Tab moves between controls; arrow keys move between swatches (as N8).
- **Narrow notes** (below 260 px, N12): the overflow menu gains **"Text style…"**, which opens
  the same popover.
- Not shown on read-only (edit-locked) notes or locked private notes: the bar is not shown
  there today and nothing changes that.
- Colours, sizes and icons: `src/styles/tokens.css` and `src/components/icons.ts`
  (`alignleft`, `aligncenter`, `alignright`, `undo`, `redo`, `chevdown`, `close` exist). The
  six text and four highlight colours come from N14 and are added to `tokens.css` as tokens
  (my call), since they are not there yet.

## 5. Data and validation (core)

Note content stays validated Tiptap JSON. No migration: formatting lives inside
`content_json`.

New in the allowlist (`crates/desknotes-core/src/validation.rs`), with the shared fixture
`tests/fixtures/rich-doc.json` updated to contain each one:

| Where | Name | Allowed values |
|---|---|---|
| mark | `textStyle` | attributes `fontFamily`, `fontSize`, `fontWeight`, `color` only, each optional or null |
| — `fontFamily` | | passes `validate_font_name` (the DES-19 rule) |
| — `fontSize` | | `"10px"` … `"32px"`, whole numbers |
| — `fontWeight` | | `"300"`, `"400"`, `"500"`, `"600"` |
| — `color` | | one of the 6 text colours |
| mark | `highlight` | attribute `color`: one of the 4 highlight colours |
| node attr | `textAlign` on `paragraph` and `heading` | `"left"`, `"center"`, `"right"` or null |

Anything else in those marks or attributes is refused, as unknown marks are today.

- Pasting: the editor keeps only allowed values from pasted HTML and drops the rest, keeping
  the text — in the extensions' HTML parsing and in the existing `sanitizeDoc` safety net, so
  a note opened with older stray values also saves (as was done for links).
- Backup: no new format number. Backup format 3 (DES-19) is not released yet and ships in the
  same version, so a format-3 file may contain these marks (my call). `docs/backup-format.md`
  lists them.
- Editor packages: `@tiptap/extension-text-style` (TextStyle, Color, FontFamily, FontSize),
  `@tiptap/extension-highlight` and `@tiptap/extension-text-align`, all 3.32.2 (the version of
  the other Tiptap packages), MIT, open-source, offline. Font weight is a small local extension
  adding a `fontWeight` attribute to `textStyle`. `docs/design.md` §2 lists the new packages.

## 6. Constraints

- No network, accounts or telemetry. Fonts are local only.
- Content is never HTML in storage; validation in Rust; `src/ipc` is the only `invoke` caller.
- New marks and attributes: allowlist plus shared fixture, in the same change.
- Tokens and icons only; the layout and copy follow N14 / N12.
- Tests: Rust validation (each allowed value and its refusals), the TypeScript sanitizer
  (pasted values outside the sets are dropped), the case change keeping marks, the popover's
  behaviour, and real-app checks recorded in `docs/testing/`.

## 7. Left to the builder

- How the popover is positioned (the existing `@floating-ui/dom` or plain CSS), as long as it
  stays inside the note window.
- How the case change walks the selection, as long as marks are kept and it is one undo step.
- Exact component split between `FormatBar.tsx` and a new `TextStylePopover.tsx`.
