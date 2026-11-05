# Completed notes — design (Milestone 4, DES-39)

Date: 2026-11-05 · Jira: DES-39 (parent DES-5)
Sources:
- Owner's design R2 ("DeskNotes Lock Settings Reminders"): manager tabs "Active · Completed · Reminders · Archived · Trash".
- `docs/ui-design-brief.md`: "later also Completed and Reminders".
- **Option A**, chosen by the owner from two mockups drawn in chat (2026-11-05).

Anything not shown in those is marked **(my call)**.

## 1. Intent

Sticky notes are often things to do. When one is done, it should leave the desktop, without being archived or thrown away, and stay findable as done. If it was marked done by mistake, it can come back.

## 2. Goals and non-goals

**Goals**
- **Mark as done** in the note's ⋯ list, just below Set reminder… (icon `check`; my call), and the shortcut **Ctrl+D** while the note has focus. Tiptap and DeskNotes don't use Ctrl+D today; the builder confirms this.
- **Undo strip.** When a note is marked done, it shows a strip saying "Marked done" with an **Undo** button for 5 seconds, then closes (my call: the undo lives in the note itself, which is where the user is looking). Undo, or pressing Ctrl+Z while the strip is visible, keeps the note open and not done.
- **Completed tab** in the manager, between Active and Reminders (R2 order). It shows a count, like the other tabs.
- **Rows** in the Completed tab: colour dot, title ("Private note" while locked, as the other tabs do), "Done today 16:40" / "Done Tue" / "Done 3 Nov" (the date style of the other tabs; my call), and a **Reopen** button. It works like the Archived tab and its "Unarchive" button.
- **Reopen** clears "done". The note returns to Active and its window opens where it was, with the same size, colour and always-on-top setting.
- **Search** in the manager also covers the Completed tab.

**Non-goals**
- Done states inside checklists, and auto-completing a note when every box is ticked (a possible later idea).
- Statistics or a history of what was done when.

**Anti-goals** (failures even if they "work")
- A done note's content changing. Marking done or Reopen touches only the done date (and the window's visibility), never the text, colour, settings or reminder rule.
- A done note's reminder firing. It does not fire while the note is done. After Reopen, a past due time shows as overdue (as after restoring from trash).

## 3. Rules

- **Lists.** A note is in exactly one list:
  - Trash if deleted;
  - else Archived if archived;
  - else Completed if done;
  - else Active.

  Archiving or trashing a done note keeps its done date (my call), so restoring it from the trash brings it back to Completed.
- **Locked notes.** A read-only (edit-locked) note can be marked done; marking done is not an edit (my call). A locked private note shows no menu, as today. Reopen from the manager works while the lock is on, and the note opens locked.
- **Duplicate.** Duplicating a done note makes an Active, not-done copy (my call).
- **Start-up.** Done notes don't open at start-up and aren't counted by "Show hidden notes".
- **Backups.** Backup format 5 adds the done date; formats 1–4 still import (every note not done).

## 4. Data

- **Migration v7** (appended only): `notes.completed_at INTEGER NULL`, in UTC ms. No existing data changes.
- **Core:**
  - a `set_completed(id, done, now)` function, following `set_archived`;
  - list filters and counts updated with the rules above;
  - the reminder `due` and `next_wake` queries skip done notes, like trashed ones;
  - `list_reminders` leaves out done notes, so they don't appear in the Reminders tab while done (my call).
- **Shell:** one command `set_note_completed(id, done)`.
  - It closes the window when a note is marked done, after the strip's 5 s. The note window calls the command when the strip ends, so the core state changes only once (my call: during the 5 s nothing is written).
  - It opens the window on Reopen, using the existing archive and unarchive paths.

## 5. Constraints

- Tokens and icons only. Copy, verbatim:
  - "Mark as done", "Completed", "Marked done", "Undo", "Reopen";
  - "Done …" dates;
  - empty tab: "Nothing completed yet." (my call, matching "Nothing archived.").
- All SQL lives in the core and `src/ipc` is the only `invoke` caller.
- Window titles never show note text.
- Real-app checks are recorded in `docs/testing/`.
