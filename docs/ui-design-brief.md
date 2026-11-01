# DeskNotes — UI design brief

Use this document as the prompt or attachment for the prototype (for example in
Claude Design). It describes every screen DeskNotes needs, what each one shows,
its states, and the technical limits the design must respect.

---

## 1. What DeskNotes is

A sticky-note app for the desktop. Each note is its **own small floating window**
that stays on the screen, keeps its place and size after a restart, and can be
coloured and formatted. A separate **manager** window lists, searches and organises
all notes. Everything stays on the computer: no account, no cloud, works offline.

First platform: Ubuntu 24.04 (GNOME). Later: Windows and macOS. The design must
look at home on all three, so avoid anything GNOME-only or macOS-only.

**Personality:** calm, paper-like, quick. A note should feel like a real sticky
note, not like a web page. Controls appear when needed and stay out of the way
when you are just reading.

## 2. Hard technical limits (please respect these)

| Limit | Why |
|---|---|
| No web fonts, images or icons loaded from the internet | The app is offline and its security policy blocks external files. Use the system font stack and **inline SVG icons**. |
| System fonts only: `system-ui, "Ubuntu", "Cantarell", "Segoe UI", "Noto Sans", sans-serif` | The same font is not installed everywhere. |
| Note windows have **no operating-system title bar** | The note draws its own header, which is also the drag handle. The manager and settings windows keep the normal OS title bar. |
| Window sizes are real pixels on a desktop | Note default 300 × 280, minimum 180 × 120. Manager default 560 × 620, minimum 400 × 360. Notes can be made very large too. |
| Text on every note colour must reach WCAG AA contrast (4.5:1) | Readability is a core requirement. |
| Everything usable from the keyboard, with a visible focus ring | Accessibility requirement. |
| Plain CSS (or CSS variables / tokens). No Tailwind or UI kit is required | Keeps the app light. Tokens and component specs are the most useful output. |
| Rendering engine is WebKit (Safari-level CSS) | Avoid very new CSS features that Safari 16 does not support. |

## 3. Screens to design

Priority: **A** = needed now (Milestone 1), **B** = soon (Milestones 2–3),
**C** = later (Milestone 4). Please design A fully; B and C can be lighter.

### 3.1 Note window — A

The heart of the app. One window per note.

**Layout**
- **Header strip** (about 32 px high, slightly darker shade of the note colour).
  It is the drag area. Contains:
  - a small grip mark on the left;
  - the formatting toolbar (see below), shown on hover or keyboard focus only;
  - on the right: colour button, "more" menu button (⋯), hide button (✕).
- **Body**: the editable text, comfortable padding, scrolls when long.
- **Save indicator**: tiny, bottom-right ("Saved", "Saving…"). Must be discreet.

**Formatting toolbar (Milestone 1 set)**
Bold, Italic, Underline, Strikethrough, Heading, Bulleted list, Numbered list,
Checklist, Link. Each button shows its active state (e.g. Bold is "on" when the
cursor is in bold text).

**Milestone 3 additions** (design where they would go, e.g. a second row or an
"Aa" popover so the header stays compact): font family, font size, font weight,
text colour, highlight colour, alignment, UPPERCASE / lowercase, undo / redo.

**Narrow windows:** at 180–240 px wide the full toolbar does not fit. Show how it
collapses (for example the less-used buttons move into an overflow menu).

**Popovers and inline parts**
- **Colour picker**: 8 preset swatches (section 4) plus, later, a custom colour.
  The current colour is marked.
- **More menu (⋯)**: New note (Ctrl+N), Duplicate, Always on top (B), Open manager,
  Archive, Move to trash.
- **Link editor**: small inline field under the header to add, change or remove a
  link. Shows an error if the address is not a web or e-mail link.

**States to show**
1. Reading (toolbar hidden, just the text).
2. Editing / hovered (toolbar visible).
3. Empty new note with the cursor ready (placeholder like "Write something…").
4. Long note scrolling.
5. **Save failed**: a clearly visible but non-panicking message inside the note,
   "Not saved. Your text is kept in this window." with a **Retry** button.
6. Note could not be opened: short message plus "Open manager" button.
7. Each of the 8 colours, and the high-contrast variant (B).
8. Compact and comfortable layouts (B): different padding and font size.
9. **Locked** (B): the note shows **no text at all** — only a lock symbol,
   "Locked", and an "Unlock" button. Not a blur: the content must be fully gone.
10. Always on top active (B): a small pin indicator in the header.

**Checklists:** checked items are struck through and dimmed. Links are underlined;
plain click edits, **Ctrl+click opens** the link (a hint on hover is welcome).

### 3.2 Manager window — A

Finds and organises notes. Normal OS title bar.

**Layout**
- Top bar: **+ New note** (primary button), **search field**, and a menu or
  Quit button (Settings goes here later).
- Tabs: **Active · Archived · Trash** (later also **Completed** and **Reminders**).
- List of notes, newest edited first. Each row shows:
  - colour marker of the note;
  - title (first line of the note; "Empty note" if blank);
  - last edited (time if today, else date);
  - whether it is currently shown on the desktop;
  - actions: Show / Hide, Archive, Move to trash (Active tab); Unarchive (Archived);
    Restore, Delete permanently (Trash).

**States to show**
1. Normal list with several notes of different colours.
2. Search with results and with no results ("No notes match your search").
3. Empty states per tab ("No notes yet. Press Ctrl+N to create one.",
   "Nothing archived.", "The trash is empty.").
4. **Permanent delete confirmation**: inline or dialog, "Delete forever? This cannot
   be undone." with Cancel and Delete (Delete in a danger colour).
5. Error banner (e.g. "The notes database could not be opened…").
6. **Locked** (B): list replaced by the lock screen; titles must not be visible.
7. Many notes (30+): the list should stay scannable.

### 3.3 Lock screen and PIN — B

Appears in the manager and, in a smaller version, inside each note window.

- 6-digit PIN entry (digits shown as dots), with a number pad usable by mouse and
  by typing.
- Wrong PIN: short error, attempts are slowed down: show "Try again in 30 s"
  with a countdown; input disabled during the wait.
- Link: "Forgot your PIN?" → recovery-code entry screen (6 groups of 4 characters).
- **Set up PIN** flow: choose PIN → confirm PIN → show the **recovery code** once,
  with "I've written it down" confirmation and a print/copy option.
- **Change PIN**: requires the current PIN first.
- Short honest note somewhere in settings: "The lock hides your notes from people
  looking at your screen. It does not encrypt the notes file."

### 3.4 Settings window — B

Sections (tabs or a left list):
- **General**: launch at login (switch), default colour for new notes, minimum
  note size, show/hide all notes shortcut.
- **Appearance**: high-contrast mode, compact / comfortable layout, default font,
  default font size, reset appearance.
- **Privacy**: enable lock, lock after inactivity (1, 5, 10, 15 minutes), Lock now,
  change PIN, regenerate recovery code.
- **Backup**: Export backup…, Restore from backup… (with a confirmation that
  explains what will be replaced), last backup date.
- **About**: version, where data is stored (folder path with "Open folder"),
  license, "no data leaves this computer" statement.

### 3.5 Reminders — C

- Inside a note: set a date / time, repeat (none, daily, weekdays, weekly, monthly),
  shown as a small chip in the header ("Tue 14:00").
- Manager **Reminders** tab: upcoming list grouped Today / Tomorrow / Later,
  overdue items highlighted.
- Desktop notification: note title only (or "Private note" when locked), with
  Snooze (10 min, 1 h, tomorrow) and Dismiss.

### 3.6 Small shared pieces — A

Buttons (primary, normal, danger, icon-only), text field, search field, tabs,
popover, menu, inline confirmation, error banner, toast/save indicator, switch
(B), focus ring. Please provide them as a mini component sheet with all states:
default, hover, active, focus, disabled.

## 4. Colours and type to start from

Current note presets (dark ink text `#1f2328` passes AA on all of them).
Feel free to refine them, but keep AA contrast and send the final hex values.

| Name | Hex |
|---|---|
| Lemon (default) | `#fff4a3` |
| Peach | `#ffd8b1` |
| Rose | `#ffd6e0` |
| Lilac | `#e4d7ff` |
| Sky | `#cfe8ff` |
| Mint | `#c8f7c5` |
| Sand | `#efe6d8` |
| Paper | `#ffffff` |

Other tokens in use: muted text `#59636e`, focus `#0b57d0`, danger `#b3261e`,
radius 8 px, base font size 15 px, line height 1.45.

A dark theme for the manager and settings is welcome; notes keep their own colours.

## 5. Keyboard shortcuts the design should surface

| Action | Shortcut |
|---|---|
| New note | Ctrl+N |
| Hide note | Ctrl+W |
| Bold / Italic / Underline | Ctrl+B / Ctrl+I / Ctrl+U |
| Strikethrough | Ctrl+Shift+S |
| Heading 1–3 | Ctrl+Alt+1–3 |
| Numbered / bulleted / checklist | Ctrl+Shift+7 / 8 / 9 |
| Link | Ctrl+K |
| Undo / Redo | Ctrl+Z / Ctrl+Shift+Z |

(On macOS, Ctrl becomes Cmd.)

## 6. Things to avoid

- Anything that looks like a website (big hero headers, marketing layouts).
- Showing note text in places others can see: window titles, notifications when
  locked, previews on the lock screen.
- Blur or transparency as a privacy measure.
- Crowding the note window: the default view is just the text.
- Tiny click targets: at least 24 × 24 px, 32 px preferred.

## 7. What to hand back

1. Screens for every **A** state above, and as many **B/C** screens as practical.
2. A token list (colours, spacing, radius, type sizes, shadows) as CSS variables.
3. The component sheet from 3.6.
4. Inline SVG icons for: grip, colour, more, close/hide, pin, lock, bold, italic,
   underline, strike, heading, bullet list, numbered list, checklist, link, search,
   trash, archive, restore, settings, bell (reminder).
5. If the tool exports HTML/CSS or React, that is ideal: it will be adapted into
   the existing React components (`src/features/notes`, `src/features/manager`).
