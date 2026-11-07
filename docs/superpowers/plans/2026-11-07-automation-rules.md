# Automation Rules Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Four opt-in rules, set in Settings → Automations: mark a checklist done when every item is ticked, untick a checklist when its repeating reminder goes off, archive done notes after N days, and empty old trash after N days.

**Architecture:**
- **Core:** stores the settings and runs each rule's data change in one transaction, refusing locked notes.
- **Shell:** runs rules 3 and 4 at start-up, every hour and after a setting change. It hooks rule 2 into the reminder firing pass and sends a window-scoped event to an open note.
- **Editor:** does rule 1 and the open-window half of rule 2, with the existing done-strip look.
- **Settings:** gains an Automations section.

**Tech Stack:** Rust (`desknotes-core`, Tauri 2 shell), React 19 + TypeScript, Tiptap 3, Vitest.

**Spec:** `docs/superpowers/specs/2026-11-06-automation-rules-design.md`

## Global Constraints

- **Branch `feat/automation-rules`.**
  - If PR #25 (`fix/window-scoped-events`, DES-41) is merged, rebase on `main`. If not, stack on `fix/window-scoped-events` and say so in the PR.
  - Task 4 needs its `listenHere` helper in `src/ipc/events.ts`.
  - Conventional Commits with the footer `Refs: DES-42` and one `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` line.
  - Never stage `.superpowers/`.
- **Project rules:**
  - All SQL in the core.
  - `src/ipc` is the only `invoke` / `listen` caller.
  - Validate in Rust.
  - No new migration: settings keys only.
  - Tokens and icons from `tokens.css` / `icons.ts`: the existing `clock` icon, no new icon.
- **Settings keys, verbatim:**
  - `auto_complete_checklists`, `reset_checklists_on_repeat`, `archive_done_enabled` and `purge_trash_enabled` hold `"1"` or are absent.
  - `archive_done_days` defaults to 7, range 1–90. `purge_trash_days` defaults to 30, range 7–365.
  - `purge_trash_off_by_restore` holds `"1"` or is absent.
- **Day arithmetic:** cutoff = `now_ms - days × 86_400_000`. "Older than" means strictly `<` cutoff.
- **Every rule is off by default**, on a fresh database and after an upgrade.
- **Copy, verbatim:**
  - Section label: `Automations`.
  - Intro: `Small rules DeskNotes follows for you, on this computer only. Each one is off until you turn it on.`
  - Row 1: `Mark a checklist done when every item is ticked` / `The note moves to Completed, with Undo for a few seconds. Notes with a repeating reminder stay open.`
  - Row 2: `Untick a checklist when its repeating reminder goes off` / `Good for daily or weekly routines.`
  - Row 3: `Archive done notes` / `Nothing is deleted; they stay in Archived.`
  - Row 4: `Empty old trash` / `Deletes notes for good. Backups you made keep them.` (danger ink).
  - Day fields: `after` [N] `days`.
  - After a restore: `Turned off when a backup was restored.`
  - Dialog title: `Empty old trash?`
  - Dialog body, first paragraph: `Notes that have been in the trash for more than {N} days will be deleted for good, now and from then on.`
    - When K = 1: ` There is 1 such note right now.`
    - When K > 1: ` There are {K} such notes right now.`
    - When K = 0: ` There are no such notes right now.`
  - Dialog body, second paragraph: `This can't be undone. Backups you have already made still contain them.`
  - Dialog buttons: `Cancel` · `Turn on` (danger).
  - Strips: `Marked done · every item is ticked` (with Undo) and `Checklist reset for this reminder` (with Undo).
- **Gate before every commit:**
  - `npm test && npm run lint && npm run typecheck`
  - `cargo test --workspace`
  - `cargo clippy --workspace --all-targets -- -D warnings`
  - `cargo fmt --all --check`

## Review Focus

1. **A locked private note is never changed by any rule**, including archive, purge and untick, and is not counted in K. Owner: Task 1, `rules_skip_locked_private_notes`.
2. **A snoozed reminder going off again does not untick a second time.** Owner: Task 1, `reset_only_on_the_first_fire_of_an_occurrence`.
3. **A restore switches rule 4 off** even when the restored file was made with the rule on, and the N survives. Owner: Task 1, `restore_turns_purge_off_and_keeps_days`.
4. **Rule 1 never fires** on load, on Undo, for a done note, or for a note whose reminder repeats. Owner: Task 4, `auto_complete_only_on_a_users_last_tick`.
5. **Rule 2 with the window open** never overwrites unsaved typing: the reset happens in the editor, not in the database. Owner: Task 2, `open_window_gets_the_event_not_a_db_write`; Task 4, `reset_event_unticks_in_the_editor_with_undo`.

---

### Task 1: Core — settings, rule data changes, restore guard

**Files:**
- New `crates/desknotes-core/src/db/automation.rs`, plus the keys in `db/settings.rs`.
- `db/backup.rs` (restore guard).
- A pure untick helper in `validation.rs`, or in a new `checklist.rs`, next to the other content walkers.

**Interfaces (produced):**
- `#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)] #[serde(rename_all = "camelCase")] pub struct Automations`, with these fields:
  - `auto_complete_checklists: bool`
  - `reset_checklists_on_repeat: bool`
  - `archive_done_enabled: bool`
  - `archive_done_days: u32`
  - `purge_trash_enabled: bool`
  - `purge_trash_days: u32`
  - `purge_off_by_restore: bool`
- `Database::automations(&self) -> CoreResult<Automations>`.
- `Database::set_automations(&self, a: &Automations) -> CoreResult<Automations>`.
  - It validates the ranges, and gives `Validation` with the field name when they are out of range.
  - It clears `purge_trash_off_by_restore` when `purge_trash_enabled` is set true.
  - `purge_off_by_restore` in the input is ignored.
- `Database::archive_done_before(&self, cutoff_ms: i64) -> CoreResult<usize>` archives notes that:
  - have `completed_at < cutoff`;
  - are not archived or deleted;
  - are not withheld by the lock.
- `Database::purge_trashed_before(&self, cutoff_ms: i64) -> CoreResult<usize>` deletes notes with `deleted_at < cutoff`, skipping withheld notes. It uses the same delete as `purge_note`, with the cascade.
- `Database::count_purgeable(&self, cutoff_ms: i64) -> CoreResult<usize>` counts the same set as `purge_trashed_before`.
- `pub fn untick_all(doc: &Value) -> Option<Value>` returns a copy with every `taskItem` set to `attrs.checked = false`, or `None` when no item was checked.
- `Database::untick_checklist(&self, note_id: &str) -> CoreResult<bool>`:
  - refuses withheld notes (`PrivateLocked`) and edit-locked notes (`NotAllowed`);
  - saves through the `save_content` path (title, search text and image references), in one transaction;
  - returns false when nothing changed.
- `Database::checklist_reset_due(&self, note_id: &str, fired_due: i64) -> CoreResult<bool>` is true only when **all** of these hold:
  - rule 2 is on;
  - the note's reminder exists, and its repeat is not `None`;
  - `fired_due == reminder.due_at`, which means not a snooze;
  - the note is not completed, archived, deleted, withheld or edit-locked;
  - the note has at least one checked `taskItem`.
- **Restore:** `restore_backup` sets `purge_trash_enabled` absent and `purge_trash_off_by_restore = "1"` in the same transaction, but only when rule 4 was on. `purge_trash_days` is kept.

**Steps:**
- [ ] **Write failing tests**, in `db/automation.rs` unless noted:
  - `defaults_are_all_off`: a fresh DB gives everything false, with days 7 and 30.
  - `set_automations_validates_ranges`:
    - archive 0 and 91 are refused, and 1 and 90 are accepted;
    - purge 6 and 366 are refused, and 7 and 365 are accepted;
    - a refusal changes nothing.
  - `archive_done_before_archives_only_old_done_notes`:
    - with cutoff = now − 7 d, a note done 8 d ago is archived;
    - a note done 6 d ago is not;
    - a not-done note is not;
    - an already archived or trashed note is not;
    - the returned count matches.
  - `purge_trashed_before_and_count_agree`: three trashed notes at 40, 31 and 29 days with N = 30. Count is 2, the purge returns 2, and the 29-day note remains.
  - `rules_skip_locked_private_notes`: with a PIN set and locked, a private done note older than N is not archived, a private trashed note is neither counted nor purged, and `untick_checklist` on a private note gives `PrivateLocked`.
  - `untick_all_unticks_nested_items`: a doc with a nested `taskList` has all items unticked. A doc with none checked gives `None`. Non-task content is identical.
  - `untick_checklist_saves_and_refuses_edit_locked`: content is unticked, and the search text and title are recomputed. An edit-locked note gives `NotAllowed` and nothing changes.
  - `reset_only_on_the_first_fire_of_an_occurrence`:
    - a daily reminder whose fired due equals `due_at`, with rule 2 on and a checked item, gives true;
    - after a snooze, a fire at `snoozed_until` gives false;
    - repeat `None` gives false;
    - rule 2 off gives false;
    - a completed note gives false;
    - no checked item gives false.
  - In `db/backup.rs`, `restore_turns_purge_off_and_keeps_days`: with rule 4 on and days 45, a restore leaves enabled false, days 45 and `purge_off_by_restore` true. Then `set_automations(enabled: true)` clears the flag.
- [ ] **Run** and expect FAIL.
- [ ] **Implement.**
- [ ] **Run** and expect PASS, then the gate.
- [ ] **Commit:** `feat(core): automation rule settings and their data changes`.

### Task 2: Shell — commands, hourly run, reminder hook

**Files:**
- New `src-tauri/src/automation.rs`.
- `src-tauri/src/commands/settings.rs` (commands, `SettingsView.automations`), `lib.rs` (register, start), `reminders.rs` (hook).
- `src/ipc/commands.ts`, `src/ipc/events.ts`, `src/types/note.ts`, `src/dev/preview.tsx`.

**Interfaces:**
- **Consumes:** everything Task 1 produces.
- **Produces:**
  - `SettingsView.automations: Automations`.
  - Commands:
    - `#[tauri::command] set_automations(app, state, automations: Automations) -> IpcResult<Automations>`. It saves, runs rules 3 and 4 once at once (off the main thread), and emits `AUTOMATIONS_CHANGED` with the saved value to every window.
    - `#[tauri::command] count_purgeable(state, days: u32) -> IpcResult<usize>`. It validates days 7–365.
  - `pub fn automation::start(app: &AppHandle)`:
    - it runs once right after the database opens (before windows show), then every 3600 s on a background thread;
    - each run applies rule 3 then rule 4 when on, using `now`;
    - it logs counts and logs errors only;
    - it emits `notes-changed` when anything changed.
  - Reminder hook: after a successful `mark_fired(note_id, due)` in `reminders.rs` (both the live pass and the start-up summary path), call `automation::on_fired(app, note_id, due)`, which:
    1. asks `checklist_reset_due`;
    2. when the note's window exists, `emit_to` that window `CHECKLIST_RESET` with payload `{ noteId }`;
    3. otherwise calls `untick_checklist`, then emits `notes-changed`;
    4. never blocks the reminder thread on the UI, and only logs errors.
  - TS:
    - `type Automations` in `src/types/note.ts`, matching the Rust fields in camelCase;
    - `commands.setAutomations(a)`;
    - `commands.countPurgeable(days)`;
    - `onAutomationsChanged(h)`: app-wide, plain `listen`;
    - `onChecklistReset(h)`: window-scoped, using `listenHere` from PR #25.
  - Event names: `AUTOMATIONS_CHANGED = "automations-changed"` and `CHECKLIST_RESET = "checklist-reset"`.

**Steps:**
- [ ] **Write failing tests:**
  - **Rust**, a pure `run_rules(db, now_ms) -> RuleCounts { archived, purged }` helper in `automation.rs`, tested on an in-memory DB:
    - with both rules off it gives 0/0;
    - with both on it gives the counts.
  - **Rust**, `open_window_gets_the_event_not_a_db_write`: extract the decision into a pure `fn reset_action(window_exists: bool, due: bool) -> ResetAction { Emit, WriteDb, Nothing }` and test all four combinations.
  - **TS:**
    - `setAutomations` invokes `set_automations` with `{ automations }`;
    - `countPurgeable` invokes `count_purgeable` with `{ days }`;
    - `onChecklistReset` registers with the current window's label;
    - `onAutomationsChanged` registers globally.
- [ ] **Run** and expect FAIL.
- [ ] **Implement.** Add preview mocks: `automations` defaults, `countPurgeable` gives 4.
- [ ] **Run** and expect PASS, then the gate and `cargo build -p desknotes`.
- [ ] **Commit:** `feat: automation commands, hourly run and checklist reset on repeat`.

### Task 3: Settings → Automations section

**Files:**
- `src/features/settings/SettingsWindow.tsx`. Add the section between Appearance and Privacy. A new `AutomationsPane.tsx` is allowed if the file grows.
- Its test.
- `src/styles/settings.css`, reusing `.dn-card*`, `.dn-switch`, `.dn-size-field` and the modal styles.
- `src-tauri/src/commands/settings.rs` `parse_section`: accept `automations`.

**Behaviour:**
- **Layout:** the mockup layout and the Global copy.
- **Switches** call `setAutomations` with the whole object changed by one field.
- **Day fields** save on blur or Enter. A Rust `Validation` error shows the existing min-size error text pattern, and the field resets to the saved value.
- **Turning rule 4 on:**
  - first `countPurgeable(days)`, then the dialog;
  - Cancel leaves it off;
  - Turn on saves it.
- **Changing rule 4's days while it is on:** the dialog shows only if `countPurgeable(new)` is greater than `countPurgeable(old)`.
- **After a restore:** when `purgeOffByRestore` is true, show `Turned off when a backup was restored.` under row 4, in the muted style.
- **Live update:** the section updates on `onAutomationsChanged`.

**Steps:**
- [ ] **Write failing tests:**
  - the order of the rows and their texts, verbatim;
  - toggling row 1 calls `setAutomations` with `autoCompleteChecklists: true` and everything else unchanged;
  - an archive days value of `0` shows the error and resets;
  - turning rule 4 on calls `countPurgeable(30)`, and the dialog text says `There are 4 such notes right now.`: Cancel then means no save, Turn on means a save with `purgeTrashEnabled: true`;
  - the singular and K = 0 texts;
  - lowering days 30 to 20 while on, with counts 4 to 6, shows the dialog; raising days 30 to 40 does not;
  - the `purgeOffByRestore` note appears;
  - `?w=settings&section=automations` opens at the section in the preview.
- [ ] **Run** and expect FAIL.
- [ ] **Implement.**
- [ ] **Run** and expect PASS, then the gate.
- [ ] **Check the preview** in light and dark at 680 × 520 against the mockup.
- [ ] **Commit:** `feat(settings): Automations section`.

### Task 4: Editor — rule 1 and the open-window reset

**Files:**
- `src/features/notes/NoteWindow.tsx`.
- `src/features/notes/DoneStrip.tsx`: it takes `text` and `onUndo`, and defaults to `Marked done`.
- A small pure `checklist.ts`: `allTasksChecked(doc)` and `untickAll(editor)`.
- Tests next to each.

**Behaviour:**
- **Rule 1:**
  - **When:** the note window knows `automations.autoCompleteChecklists` (from `getSettings` and `onAutomationsChanged`). On a transaction that the user made, that is `docChanged`, not the load, not an undo or redo (`isUndoing`/`history` meta) and not a remote set, and that turns some `taskItem` `checked` from false to true and leaves **every** `taskItem` checked.
  - **Skipped when:** the note is already done, or its `reminder?.repeat` is set and is not `"none"`.
  - **Then:** run the existing done-strip flow with the text `Marked done · every item is ticked`.
- **Rule 2, window open:**
  - **When:** on `onChecklistReset({ noteId })` for this note, when the editor is editable.
  - **Then:**
    - remember the checked state;
    - untick every `taskItem` in one transaction that adds to history;
    - show a strip `Checklist reset for this reminder` with Undo for 5 s;
    - Undo re-ticks exactly the remembered items;
    - autosave saves as usual.
  - **While a "Marked done" strip is showing:** ignore the reset.

**Steps:**
- [ ] **Write failing tests:**
  - `auto_complete_only_on_a_users_last_tick`:
    - with rule on, a note with 2 items, tick 1 then tick 2: the strip shows with the reason text, and after 5 s `setNoteCompleted` is called;
    - opening a fully ticked note does nothing;
    - Undo of the strip does nothing more;
    - rule off does nothing;
    - a daily reminder does nothing;
    - an already done note does nothing.
  - `reset_event_unticks_in_the_editor_with_undo`:
    - an event for this note unticks 3 items and shows the strip, and Undo re-ticks them;
    - an event for another note id does nothing;
    - an event while not editable does nothing.
  - `DoneStrip` renders a custom text, and `Marked done` by default.
- [ ] **Run** and expect FAIL.
- [ ] **Implement.**
- [ ] **Run** and expect PASS, then the gate.
- [ ] **Commit:** `feat(notes): auto-complete checklists and reset them on repeat`.

### Task 5: Real-app check and docs (controller)

**Steps:**
- [ ] **Release build**, run isolated (scratch `HOME`, private bus, Xvfb), and check:
  - **Rule 1:** tick the last item → strip, then Completed; Undo keeps the note open.
  - **Rule 2:** a daily reminder due now on an open checklist note → unticked, strip, Undo. With the note window closed → unticked in the DB.
  - **Rules 3/4:** seed a scratch DB (read-write is fine, it is scratch) with `completed_at` / `deleted_at` 8 and 31 days ago. Start with rules on → archived / purged, and the 6- and 29-day notes are kept.
  - **The rule 4 dialog** shows the right count, and Cancel changes nothing.
  - **Restore** a backup with rule 4 on → it is off, and the note line shows.
  - **Locked private notes** are untouched.
- [ ] **Record** in `docs/testing/m4-automation-rules-verification.md`, and add a CHANGELOG Unreleased entry.
- [ ] **Commit:** `docs: automation rules verification`.
