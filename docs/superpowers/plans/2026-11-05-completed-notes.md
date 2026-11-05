# Completed Notes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Mark a note as done from its menu (or Ctrl+D) so it leaves the desktop after a 5-second Undo strip, list done notes in the manager's Completed tab with Reopen, and stop reminders on done notes.

**Architecture:** One new nullable column, `notes.completed_at` (migration v7). Completed notes follow the archive path end to end, from core filters and counts through the window close/open path to the manager tab. The rules for which list a note belongs to live only in core SQL.

**Tech Stack:** Rust (`desknotes-core`), Tauri 2, React 19 + TypeScript, Vitest.

**Spec:** `docs/superpowers/specs/2026-11-05-completed-notes-design.md`

## Global Constraints

- **Branch and commits:**
  - Branch `feat/m4-completed`, stacked on `feat/note-menu` (PR #20).
  - Conventional Commits with footer `Refs: DES-39` and `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
  - Never stage `.superpowers/`.
- **Project rules:**
  - Migrations are appended, never edited; no user data is rewritten.
  - All SQL lives in the core, and `src/ipc` is the only `invoke` caller.
  - Validation happens in Rust.
  - Window titles never show note text.
- **List precedence:** Trash (deleted) > Archived > Completed (`completed_at` set) > Active.
  - Archiving or trashing keeps `completed_at`.
  - Duplicate never copies `completed_at`.
- **Reminders:**
  - Done notes never fire. `due_reminders` and `next_wake` skip them, like trashed notes.
  - `list_reminders` leaves them out.
  - After Reopen, a past due time is overdue.
- **Copy, verbatim:**
  - menu item "Mark as done" (icon `check`), placed right after "Set reminder…";
  - strip "Marked done" with the button "Undo";
  - tab "Completed", between Active and Reminders, with a count;
  - row button "Reopen";
  - row dates "Done 16:40" (today), "Done Tue" (within 6 days), "Done 3 Nov" (+ year when not this year), following the style of the existing Archived row dates;
  - empty tab "Nothing completed yet.".
- **Shortcut:** Ctrl+D while the note has focus. Confirm nothing else binds it.
- **Strip:** 5 s. Undo, or Ctrl+Z while the strip is shown, cancels.
  - Nothing is written during the 5 s.
  - When the 5 s end, the note saves any pending edit, then calls `set_note_completed(id, true)`, which closes the window.
  - If the window is closed during the strip (Esc / hide / quit), the note is marked done. Only Undo cancels.
- **Backups:** format 5 adds `completedAt`. Formats 1–4 still import.
- **Gate before every commit:** `npm test && npm run lint && npm run typecheck`, `cargo test --workspace`, `cargo clippy --workspace --all-targets -- -D warnings`.

## Review Focus

1. **Content never changes.**
   - Mark done → Reopen leaves content, colour, appearance, window geometry, always-on-top and the reminder rule identical.
   - Owner: Task 1 `completing_touches_only_completed_at`, Task 2 `reopen_restores_window`.
2. **Precedence across archive and trash.**
   - Done → archive → unarchive returns to Completed.
   - Done → trash → restore returns to Completed.
   - Counts never double-count a note.
   - Owner: Task 1 `lists_follow_precedence`.
3. **Reminders on done notes.**
   - A reminder that falls due while its note is done never fires. After Reopen it is overdue and fires once.
   - Owner: Task 1 `done_notes_do_not_fire`.
4. **The strip with a pending edit.**
   - Typing, then Ctrl+D, then waiting 5 s saves the typing first.
   - Closing during the strip still marks the note done.
   - Owner: Task 3 `strip_saves_then_completes`.
5. **Locked private note.**
   - The Completed row says "Private note".
   - Reopen opens the note locked.
   - Owner: Task 4 `locked_rows_show_private_note`.

---

### Task 1: Core — column, rules, reminders, backup

**Files:**
- `crates/desknotes-core/src/db/migrations.rs` (v7);
- `db/notes.rs`: `set_completed`, the filters in `list_notes`/`note_counts`/start-up visible notes, duplicate;
- `model.rs`: `NoteFilter::Completed`, `completed_at` on `Note` and `NoteSummary`, the counts struct;
- `db/reminders.rs`: skip done notes in due, next_wake and list;
- `backup.rs` and `db/backup.rs`: format 5;
- `docs/backup-format.md`.

**Interfaces:**
- `Database::set_completed(&self, id: &str, done: bool, now_ms: i64) -> CoreResult<()>`, following `set_archived` (its error cases and trash refusal).
- `NoteFilter::Completed`.
- `NoteCounts.completed`.

**Steps:**
- [ ] Write the failing tests:
  - `completing_touches_only_completed_at`;
  - `lists_follow_precedence`, covering every combination of deleted/archived/completed against each filter and the counts;
  - `done_notes_do_not_fire`;
  - `done_notes_not_in_list_reminders`;
  - `duplicate_is_not_done`;
  - `startup_skips_done_notes`;
  - backup: format 5 round trip, format 4 imports as not done;
  - migration v7 on a v6 file keeps every note and reminder.
- [ ] Run them and confirm they FAIL.
- [ ] Implement.
- [ ] Run them and confirm they PASS, then run clippy.
- [ ] Commit: `feat(core): completed notes (migration v7, backup format 5)`.

### Task 2: Shell — command and windows

**Files:**
- `src-tauri/src/commands/notes.rs`: `set_note_completed`, next to `set_archived`'s command; register it in `lib.rs`;
- the window close and open paths in `src-tauri/src/windows/mod.rs`, reusing archive's;
- `src/ipc/commands.ts`;
- `src/types/note.ts`: `NoteFilter` gains `"completed"`, `NoteCounts.completed`, `completedAt`.

**Behaviour:**
- `set_note_completed(id, done)`:
  - done → close the note window (and the Note settings window if it is open for that note), as archive does;
  - not done → open the window at its saved geometry with focus, as unarchive does.
- Emit `notes-changed` as archive does. Wake the reminder scheduler so `next_wake` is recomputed (reuse the scheduler's existing wake on `notes-changed`, if that already covers non-content changes; confirm it).

**Steps:**
- [ ] Write the failing tests: the command's validation path, if a natural test place exists; the TS command name and args.
- [ ] Run them and confirm they FAIL.
- [ ] Implement.
- [ ] Run them and confirm they PASS, then run the full gate.
- [ ] Commit: `feat(notes): mark a note done and reopen it`.

### Task 3: Note UI — menu item, Ctrl+D, Undo strip

**Files:**
- `src/features/notes/NoteWindow.tsx`: the list item in the option-B menu and the shortcut;
- `src/features/notes/DoneStrip.tsx` (new), with its test;
- `src/styles/note.css`;
- `src/dev/preview.tsx`: mock `set_note_completed`.

**Behaviour:**
- "Mark as done" (icon `check`) goes right after "Set reminder…" and closes the menu.
- Ctrl+D (Mod-d) is handled at the note window level: when the note isn't locked-private, and both in the editor and outside it. Confirm Tiptap has no Mod-d binding; if one exists, take precedence over it.
- The strip:
  - It overlays the top of the note, under the header, with a token background, the text "Marked done" and an "Undo" button that gets focus. It shows for 5 s.
  - Undo or Ctrl+Z cancels and returns focus to the editor.
  - When the time is up, flush the pending save and then call `setNoteCompleted(id, true)`.
  - Closing or hiding during the strip calls it immediately, using the same path the note already takes on close.
  - Respect the existing quit and save-all flow, so quitting during the strip marks the note done after saving.

**Steps:**
- [ ] Write the failing tests:
  - the menu item's position and action;
  - Ctrl+D opens the strip;
  - Undo and Ctrl+Z cancel and nothing is called;
  - after 5 s (fake timers) the save happens, then `setNoteCompleted(true)`;
  - `strip_saves_then_completes` with a pending edit;
  - closing during the strip completes the note.
- [ ] Run them and confirm they FAIL.
- [ ] Implement.
- [ ] Run them and confirm they PASS, then run the gate.
- [ ] Check the preview.
- [ ] Commit: `feat(notes): Mark as done with a 5-second Undo`.

### Task 4: Manager — Completed tab

**Files:** `src/features/manager/ManagerWindow.tsx` and its test, `src/styles/manager.css`, `src/dev/preview.tsx`.

**Behaviour:**
- The tab goes between Active and Reminders and shows a count from `noteCounts().completed`.
- Rows follow the Archived row pattern: dot, title (the masked title while locked, as Archived does), "Done …" date, and a "Reopen" button calling `setNoteCompleted(id, false)`.
- The empty state reads "Nothing completed yet.".
- Search applies to this tab.
- Row click behaves as the Archived tab does.

**Steps:**
- [ ] Write the failing tests:
  - tab order and count;
  - rows and dates;
  - Reopen calls the command;
  - `locked_rows_show_private_note`;
  - search;
  - the empty state.
- [ ] Run them and confirm they FAIL.
- [ ] Implement.
- [ ] Run them and confirm they PASS, then run the gate.
- [ ] Check the preview.
- [ ] Commit: `feat(manager): Completed tab with Reopen`.

### Task 5: Real-app verification and docs

**Steps:**
- [ ] Build a release binary and run it on scratch data, with the owner's agreement.
- [ ] Check:
  - Mark as done shows the strip and closes the note;
  - the note appears in Completed;
  - Reopen brings it back where it was;
  - a done note's reminder doesn't fire.
- [ ] Record the results in `docs/testing/m4-completed-verification.md` and add a CHANGELOG entry.
- [ ] Commit: `docs: completed notes verification and changelog`.
