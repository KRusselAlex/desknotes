# Note ⋯ menu redesign — option B (DES-38)

Date: 2026-11-05 · Jira: DES-38 (parent DES-4)

The owner asked for a better note menu. There is no Claude Design export for it: three layouts
were drawn in chat with the app's colours, and the owner chose **B — quick-action row**.
Everything below that the mockup did not fix is marked **(my call)**.

## Why
The menu had grown to 11 rows, about as tall as a default note (300 × 280). Its on/off items
(Always on top, Lock editing, Private) looked the same as actions, so you could not see what
was on.

## Layout (top to bottom)
1. **Quick-action row** — four equal buttons, each an icon over a small label:
   - **New** (`plus`): new note; tooltip "New note (Ctrl+N)".
   - **Duplicate** (`duplicate`): duplicate this note. The mockup's "Copy" is renamed
     "Duplicate", so it isn't mistaken for copying text (my call).
   - **On top** (`pin`): toggles Always on top; shaded when on (`aria-pressed`).
   - **Lock** (`editlock`): toggles Lock editing; shaded when on (`aria-pressed`).
   - Each button's accessible name is the full action ("New note", "Duplicate", "Always on top",
     "Lock editing"). New and Duplicate close the menu; the two toggles keep it open so the
     shading change is seen (my call).
2. Separator.
3. **Set reminder…** (`bell`), **Note settings…** (`settings`).
4. **Private** (`lock`) with a chevron. It opens a sub-list *inside the same popover*, replacing
   the list, with a back row "Private" at the top (my call: a side submenu would leave a 300 px
   window). The sub-list holds:
   - not private: **Make private**;
   - private: **Change private label…** and **Make not private**.
   A small check after "Private" shows when the note is private (my call).
5. **Open manager** (`note`).
6. Separator, then **Archive** (`archive`) and **Move to trash** (`trash`, danger).

## Behaviour
- Keyboard: focus starts on the first quick button. ←/→ move along the row; ↓ from the row goes
  to the first list item; ↑/↓ move through the list (↑ from the first list item returns to the
  row); Home/End; Enter/Space activate; → on Private opens its sub-list, ← or Esc in the
  sub-list returns to the main list; Esc in the main list or Tab closes the menu. Focus returns
  to where it was before, as today.
- Roles: the quick toggles are `menuitemcheckbox` with `aria-checked`; New and Duplicate are
  `menuitem`; the row is a `group` labelled "Quick actions".
- At the minimum note width (180 px) the four buttons stay in one row (about 40 px each).
- Unchanged: what each action does, the narrow-note "Text style…" overflow menu, and that a
  locked private note shows no menu.

## Constraints
Tokens and icons only from `tokens.css` / `icons.ts`; reuse the existing `.dn-menu`,
`.dn-menu-item`, `.dn-menu-sep` styles; pressed shading uses `--dn-ink-press` (as the header
pin); labels 11 px muted ink (`--dn-ink-muted`). Real-app check recorded in `docs/testing/`.
