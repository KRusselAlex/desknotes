# Automation rules — design (DES-42)

Date: 2026-11-06 · Jira: DES-42 (parent DES-5, Milestone 4)
Source: the M4 plan item "a small set of explicit automation rules (no scripting, no shell
commands)". The owner asked for a proposal, agreed to the four rules below ("go"), and then
approved the mockups (`.superpowers/brainstorm/…/automations.html`, "go for it"). Anything not
fixed there is marked **(my call)**.

## 1. Why, and what success looks like
DeskNotes already has checklists, repeating reminders, "Mark as done", Archive and Trash. The
rules take over the small chores around them:
- finishing a checklist;
- starting a routine again;
- tidying done notes;
- emptying old trash.

Success means:
- a rule does exactly what its one line in Settings says;
- the user always sees why something changed;
- nothing is lost by surprise.

**Anti-goals:**
- a rule that deletes or hides something the user did not expect;
- a rule that changes a note the user is typing in;
- a rule that touches a locked private note;
- anything that runs while the app is closed, or contacts a server.

## 2. The rules
All four are **off** until the user turns them on.

1. **Mark a checklist done when every item is ticked.**
   - **When:** in a note that has at least one checklist item (`taskItem`), the user ticks the last unticked item, so that every `taskItem` in the note is checked.
   - **What:** exactly what "Mark as done" does today (DES-39). The existing "Marked done" strip shows, with Undo for 5 s, and then the note is completed.
   - **Strip text:** "Marked done · every item is ticked".
   - **Not triggered by:**
     - opening a note that is already fully ticked;
     - Undo;
     - a note that is already done;
     - **a note with a repeating reminder (owner decision 2026-11-06).** Such a note is a routine: it stays open so rule 2 can reset it. Otherwise rule 1 would complete it, done notes' reminders stop, and the routine would quietly end. One-off checklists, and notes with a one-time reminder, are still marked done.
   - **Not in a locked or edit-locked note:** the tick itself is impossible there.
2. **Untick a checklist when its repeating reminder goes off.**
   - **When:** a reminder with a repeat (daily, weekdays, weekly… whatever DES-36 offers) fires, and its note has at least one ticked `taskItem`.
   - **What:** every `taskItem` in the note becomes unticked.
     - **Note window open:** the change is made **in the editor**, as one undoable step, and saved by the normal autosave. A strip "Checklist reset for this reminder" with Undo shows for 5 s. **(my call)**: Undo restores the ticks.
     - **Window closed:** the core changes the stored content in one transaction. No strip appears.
   - **Skipped silently:**
     - while the note is privacy-locked;
     - while it is edit-locked;
     - when it is done, archived or trashed.
     It is not applied later **(my call)**.
   - **Once per occurrence (my call).** Only the first time an occurrence goes off counts, keyed on the reminder's scheduled time (`due_at`), not on a snoozed time. That includes occurrences counted in the start-up summary. So a snoozed reminder going off again never unticks a second time, and ticks the user made after snoozing are kept.
3. **Archive done notes after N days.**
   - **When:** a note's `completed_at` is older than N days, and the note is not archived or trashed.
   - **What:** it is archived, as the manager's Archive does. Nothing is deleted.
   - **N:** 1–90, default **7**.
   - **Skipped:** locked private notes. They are archived after the next unlock check **(my call)**.
4. **Empty old trash after N days.**
   - **When:** a note's `deleted_at` is older than N days.
   - **What:** it is deleted permanently, as the manager's Delete permanently (`purge_note`) does.
   - **N:** 7–365, default **30**.
   - **Skipped:** locked private notes, as `purge_note` already refuses them.
   - Their images are cleaned at the next start, as today.
   - **This is the only rule that deletes** (see §3 for the confirmation).
   - **A restore turns rule 4 off (my call).** A restored backup brings back notes with their original trash dates, so the rule could delete, within the hour, notes the user restored to get back. So restoring a backup switches rule 4 off, keeping its N. The Automations page then shows under the row: "Turned off when a backup was restored." The user turns it on again (with the usual dialog and count) once they have rescued what they need.

**Rules 3 and 4 run:**
- once at start-up, after the database opens and before windows show;
- then once an hour while DeskNotes runs **(my call)**;
- and also right after the user turns either rule on or changes its N.

**Each run** is one transaction per rule. It emits the existing notes-changed event, so the manager's lists update.

**Times** are compared in UTC milliseconds, like every other time in the app. "More than N days" means `now - N × 86 400 000 ms`. There are no calendar days, so a time-zone or DST change does not shift a rule by a day **(my call)**.

## 3. Settings → Automations (owner-approved mockup)
- **Placement:** a new section in the Settings window, between Appearance and Privacy.
  - Label: **Automations**, with the existing `clock` icon from `icons.ts`. No new icon.
  - Route: `section=automations` in the preview.
- **Intro line:** "Small rules DeskNotes follows for you, on this computer only. Each one is off until you turn it on."
- **One card with four rows**, in the order above, each with a bold label, a muted line and a switch (the existing `Switch`). Rows 3 and 4 also have "after [N] days", using the existing `.dn-size-field` number pill, greyed while the switch is off.
  1. **Mark a checklist done when every item is ticked** — "The note moves to Completed, with Undo for a few seconds. Notes with a repeating reminder stay open."
  2. **Untick a checklist when its repeating reminder goes off** — "Good for daily or weekly routines."
  3. **Archive done notes** — "Nothing is deleted; they stay in Archived."
  4. **Empty old trash** — "Deletes notes for good. Backups you made keep them." This line uses the danger ink.
- **N fields:**
  - saved on blur or Enter;
  - out-of-range or non-numbers are refused in Rust;
  - the field then shows the saved value again, with the existing small error text pattern used by "Minimum note size" **(my call)**.
- **Turning rule 4 on asks first**, with the existing modal look ("Restore this backup?"):
  - Title: **Empty old trash?**
  - "Notes that have been in the trash for more than **N days** will be deleted for good, now and from then on. There are **K** such notes right now."
  - "This can't be undone. Backups you have already made still contain them."
  - Buttons: **Cancel** · **Turn on** (danger).
  - K comes from a core count. With K = 0 the first sentence still shows, with "There are no such notes right now."
  - Changing N while the rule is on asks again only when it would delete more notes right now, showing the new K **(my call)**.
- **The others** switch on without asking.

## 4. Data and code shape
- **Settings keys** in the existing `settings` table (no migration needed):
  - `auto_complete_checklists`, `reset_checklists_on_repeat`, `archive_done_enabled` and `purge_trash_enabled`, each `"1"` / absent;
  - `archive_done_days` and `purge_trash_days`, as decimal strings.
  - The N is kept while a rule is off, so turning it back on restores it.
- **Validation:** ranges and booleans are validated in Rust. The webview calls named commands only.
- **Settings view:** the existing settings view returns an `automations` object, and setter commands change it.
- **Core functions** (all SQL in `desknotes-core`), each in one transaction:
  - archive done notes before a cutoff;
  - purge trashed notes before a cutoff, skipping locked private notes;
  - count what the purge would delete;
  - untick all task items of one note.
    - It works on the stored Tiptap JSON: set `attrs.checked = false` on every `taskItem`.
    - It goes through the same validation, title and search-text path as `save_content`.
    - It refuses a locked or edit-locked note.
- **Rule 2's trigger** lives where reminders fire (`src-tauri/src/reminders.rs`). When the note's window is open, it sends a **window-scoped** event to that note, so the editor resets the ticks itself. Otherwise it calls the core untick function.
  - The event must use the window-scoped `listen` pattern that PR #25 / DES-41 introduces. A global `listen` would reach every note.
  - **Branch base (my call).** This work starts from `main` once PR #25 is merged. If PR #25 is still open when building starts, the branch is stacked on `fix/window-scoped-events`, the PR says so, and it is rebased onto `main` after PR #25 merges.
  - "Window open" means the note's window exists. Note windows are destroyed when hidden.
- **Rule 1** lives in the editor (`NoteWindow`), on a user transaction that ticks a `taskItem`. It reuses the existing done-strip flow with the new reason text. The setting reaches the note window with its other settings, and updates live when changed.
- **The periodic run** for rules 3 and 4 is a small timer in the shell (`src-tauri/src`). It never blocks the main thread, and an error is only logged.

## 5. Out of scope
- A rule builder ("if X then Y");
- per-note rules;
- rules that touch files, other apps, the network or the clipboard;
- notifications for rules 3 and 4;
- a log of what rules did;
- anything running while DeskNotes is closed;
- backups of settings (unchanged: settings are not in backups).

## 6. Acceptance
- **Every rule is off on a fresh database and after an upgrade.**
- **Rule 1:**
  - ticking the last item shows "Marked done · every item is ticked", and after 5 s the note is in Completed;
  - Undo keeps it open;
  - opening an already fully ticked note does nothing.
- **Rule 2:**
  - a daily reminder firing with the note open unticks all items, shows the strip, and Undo re-ticks them;
  - with the window closed, the stored note is unticked;
  - a locked private note is unchanged.
- **Rule 3:** a note done 8 days ago is archived at start-up with N = 7; one done 6 days ago is not.
- **Rule 4:**
  - turning it on shows the dialog with the right count;
  - Cancel changes nothing;
  - Turn on purges exactly the notes older than N days;
  - a locked private note in the trash is kept.
- **No rule touches a note while the privacy lock withholds it.**
- **Gate:** `npm test && npm run lint && npm run typecheck`, `cargo test --workspace`, clippy `-D warnings` and `cargo fmt --check` pass.
- **A real-app check** is recorded in `docs/testing/`.
