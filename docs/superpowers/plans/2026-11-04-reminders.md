# Reminders Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** a note can carry one reminder (date, time, repeat). At the due time DeskNotes shows a desktop notification with snooze buttons, and the manager lists coming and overdue reminders (designs R1, R2, R3, B2).

**Architecture:**
- **Core:** all time logic lives in `desknotes-core` as pure functions, generic over the time zone (`chrono::TimeZone`), so DST cases are tested with a fixed zone. Storage is a new `reminders` table (migration v6) plus backup format 4.
- **Shell:** a native scheduler thread fires notifications over the desktop's D-Bus notification service and applies the action buttons through the core.
- **Webview:** draws the chip, the R1 popover and the manager tab.

**Tech Stack:** Rust (`desknotes-core`, chrono; chrono-tz as a dev-dependency for tests; a pure-Rust D-Bus notification client in the shell), Tauri 2, React 19 + TypeScript, Vitest.

**Spec:** `docs/superpowers/specs/2026-11-04-reminders-design.md`

## Global Constraints

- **Branch and commits:** `feat/m4-reminders`, stacked on `feat/m3-appearance` (PR #18). Conventional Commits with footer `Refs: DES-36` and `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never stage `.superpowers/`.
- **Project rules:**
  - no network;
  - all SQL in the core; `src/ipc` is the only `invoke` caller; validation in Rust;
  - migrations appended only; back up before upgrading (existing mechanism).
- **Notifications:**
  - Show exactly "DeskNotes" as the app name, and the note **title**, or "Private note" while the note is locked (owner decision; CLAUDE.md exception).
  - Never show the note body. Logs never contain titles.
- **Repeat values, verbatim:**
  - stored: `none`, `daily`, `weekdays`, `weekly`, `monthly`;
  - labels: "None", "Daily", "Weekdays", "Weekly", "Monthly".
- **Notification buttons, verbatim:** "10 min" (+10 min), "1 h" (+60 min), "Tomorrow" (same wall-clock time tomorrow), "Dismiss" (a one-off is removed; a repeat moves to the next occurrence).
- **Closing a notification without choosing** leaves the reminder overdue.
- **Copy, verbatim:**
  - ⋯ menu "Set reminder…" (icon `bell`, after "Always on top");
  - R1 buttons "Remove" and "Save"; label "Repeat";
  - refusal "Pick a time in the future.";
  - manager tab "Reminders"; groups "Today", "Tomorrow", "Later";
  - overdue time "Overdue · 09:30";
  - missed summary "N more reminders".
- **Chip text:**
  - "14:00" for today;
  - "Tue 14:00" for the next 6 days;
  - "4 Nov" later in the same year;
  - "4 Nov 2027" in another year.
  - 24-hour times; weekday and month names in English, as the rest of the UI (my call in the spec).
- **Rules:**
  - Monthly on the 29th–31st uses the month's last day when it is shorter.
  - A DST gap fires at the first valid minute after it; a DST overlap fires once, at the first instance.
  - A missed-at-start burst sends at most 5 notifications, plus one summary.
  - Trashed notes never fire; archived ones do.
  - Duplicate does not copy reminders; purge deletes them.
- **Tokens and icons** from `tokens.css` and `icons.ts` only (`bell`, `lock` exist).
- **Gate before every commit:** `npm test && npm run lint && npm run typecheck`, `cargo test --workspace`, `cargo clippy --workspace --all-targets -- -D warnings`.

## Review Focus

1. **Exactly-once firing across restarts.** A reminder due while DeskNotes is closed fires once at the next start, never again after a second restart, and a repeat then moves on. Owned by Task 2: `catch_up_fires_each_occurrence_once`.
2. **DST and month ends.** 02:30 on the Europe/Paris spring-forward day fires at 03:00. 02:30 on the fall-back day fires once. Monthly on the 31st falls on 30 Apr, then 31 May. Owned by Task 1: `next_occurrence_dst_and_month_end`.
3. **Private and locked.** While locked, the notification and the manager row say "Private note", and the title never reaches the notification text, a log or an event payload. Owned by Task 3: `locked_note_notification_has_no_title` and Task 5: `locked rows show Private note`.
4. **Trash and restore.** A trashed note's reminder does not fire. After a restore, a past due time is overdue and shown, not silently lost. Owned by Task 2: `trashed_notes_do_not_fire_and_restore_shows_overdue`.
5. **Snooze and dismiss on a repeating reminder.** A snooze never changes the repeat's wall-clock anchor. Dismissing a weekday reminder on a Friday moves it to Monday. Owned by Task 1: `snooze_keeps_anchor` and `dismiss_weekdays_on_friday`.

---

### Task 1: Core time logic (pure)

**Files:** `crates/desknotes-core/src/reminders.rs` (new; add `mod` and exports), `crates/desknotes-core/Cargo.toml` (`chrono` with `clock`, already in `Cargo.lock` at 0.4.45; dev-dependency `chrono-tz`, pinned).

**Interfaces (produces):**
- `pub enum Repeat { None, Daily, Weekdays, Weekly, Monthly }`, serde lowercase, with `FromStr`/`as_str`.
- `pub struct ReminderRule { pub local_date: NaiveDate, pub local_time: NaiveTime, pub repeat: Repeat }`.
- `pub fn first_due<Tz: TimeZone>(rule: &ReminderRule, tz: &Tz) -> DateTime<Utc>`. The rule's own date and time, with the DST gap and overlap rules applied.
- `pub fn next_occurrence<Tz: TimeZone>(rule: &ReminderRule, after: DateTime<Utc>, tz: &Tz) -> Option<DateTime<Utc>>`. The first occurrence strictly after `after`; `None` for a one-off that is already past.
- `pub fn snooze(now: DateTime<Utc>, by: Snooze, rule: &ReminderRule, tz: &Tz) -> DateTime<Utc>`, where `pub enum Snooze { Minutes10, Hour1, Tomorrow }`. Tomorrow is tomorrow's date at the rule's wall-clock time.
- `pub fn validate_rule(date: &str, time: &str, repeat: &str) -> CoreResult<ReminderRule>`. Accepts `YYYY-MM-DD`, `HH:MM` (24 h) and the five repeat names; refuses anything else with a validation error.

- [ ] **Step 1: Write the failing tests** in `reminders.rs`, using `chrono_tz::Europe::Paris` and `UTC`:
  - daily, weekdays, weekly and monthly next occurrences from a fixed `after`;
  - `next_occurrence_dst_and_month_end`:
    - 2026-03-29 02:30 Paris → 03:00 local;
    - 2026-10-25 02:30 → the first instance only;
    - monthly on the 31st → 30 Apr, then 31 May;
    - 29 Feb in a leap year, then 28 Feb;
  - `snooze_keeps_anchor`: a snoozed weekday reminder's next occurrence after dismiss is still at the anchor time;
  - `dismiss_weekdays_on_friday`: Friday → Monday;
  - one-off in the past → `None`;
  - a time-zone change (the same rule evaluated in `America/New_York`) keeps the wall clock;
  - `validate_rule` accepts and refuses: `2026-02-30`, `24:00`, `9:5`, `hourly`.
- [ ] **Step 2: Run them;** expect FAIL. Command: `cargo test -p desknotes-core reminders`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them;** expect PASS, then clippy.
- [ ] **Step 5: Commit:** `feat(core): reminder time rules`.

### Task 2: Core storage, catch-up and backup

**Files:** `crates/desknotes-core/src/db/migrations.rs` (v6), `crates/desknotes-core/src/db/reminders.rs` (new), `crates/desknotes-core/src/db/notes.rs` (duplicate does not copy; purge cascade check), `crates/desknotes-core/src/backup.rs` and `db/backup.rs` (format 4), `docs/backup-format.md`.

**Interfaces (consumes Task 1; produces):**
- Table as in spec §4: `note_id` is the PK and an FK to notes with `ON DELETE CASCADE`; confirm `PRAGMA foreign_keys` is on, or delete explicitly in purge.
- `pub struct Reminder { note_id, rule: ReminderRule, due_at: i64, snoozed_until: Option<i64>, fired_at: Option<i64> }`
- `Database::reminder(note_id) -> CoreResult<Option<Reminder>>`
- `Database::set_reminder(note_id, rule, now, tz) -> CoreResult<Reminder>`:
  - computes `due_at = first_due` (or the next occurrence when the rule's own time is past and it repeats);
  - refuses a past one-off with the message "Pick a time in the future.";
  - clears `snoozed_until` and `fired_at`.
- `Database::remove_reminder(note_id) -> CoreResult<()>`
- `Database::effective_due(r) = snoozed_until.unwrap_or(due_at)` (helper).
- `Database::due_reminders(now) -> CoreResult<Vec<Reminder>>`: not trashed, `effective_due <= now`, and not yet fired for that effective due time (`fired_at != Some(effective_due)`).
- `Database::mark_fired(note_id, effective_due)`
- `Database::snooze_reminder(note_id, Snooze, now, tz)`
- `Database::dismiss_reminder(note_id, now, tz)`: a one-off is deleted; a repeat gets `due_at = next_occurrence(after = max(now, due_at))`, and `snoozed_until` and `fired_at` are cleared.
- `Database::next_wake(now) -> CoreResult<Option<i64>>`: the earliest future `effective_due` on a non-trashed note.
- `Database::list_reminders(query: &str) -> CoreResult<Vec<ReminderRow>>`, with `ReminderRow { note_id, title_or_private (resolved by the caller's lock state — return title, color, private flag and leave masking to the shell), color, repeat, effective_due, overdue: bool }`. Sorted by effective due, trashed excluded.
- Backup format 4 includes reminders; formats 1–3 import with none.

- [ ] **Step 1: Write the failing tests:**
  - set, read and remove a reminder;
  - a past one-off is refused with the exact message;
  - `catch_up_fires_each_occurrence_once`: due → `due_reminders` returns it → `mark_fired` → it no longer returns it, even after reopening the database file;
  - `trashed_notes_do_not_fire_and_restore_shows_overdue`;
  - snooze, then the due list;
  - dismiss for a one-off and for a repeat;
  - `next_wake`;
  - purge removes the reminder;
  - duplicate does not copy it;
  - the backup round trip keeps reminders; a format-3 file imports;
  - migration v6 on a v5 database keeps all notes.
- [ ] **Step 2: Run them;** expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them;** expect PASS, then clippy.
- [ ] **Step 5: Commit:** `feat(core): store reminders, catch-up and backup format 4`.

### Task 3: Shell — commands, scheduler, notifications

**Files:**
- `src-tauri/src/commands/reminders.rs` (new) and `lib.rs`;
- `src-tauri/src/platform/notify.rs` (new: the D-Bus notification client);
- `src-tauri/src/reminders.rs` (new: the scheduler);
- `src-tauri/src/windows/mod.rs` (event `REMINDERS_CHANGED = "reminders-changed"`);
- `src-tauri/Cargo.toml` (the notification crate, pinned, MIT/Apache, using zbus 5 if possible — zbus 5.13.2 is already in the build);
- `docs/design.md` §2 (a row for the crate);
- `src/ipc/commands.ts`, `src/ipc/events.ts`, `src/types/*`.

**Interfaces (consumes Task 2; produces):**
- Commands:
  - `get_reminder(note_id) -> Option<ReminderView { date, time, repeat, due_at, overdue }>`
  - `set_reminder(note_id, date, time, repeat) -> ReminderView`
  - `remove_reminder(note_id)`
  - `list_reminders(query) -> Vec<ReminderListRow { note_id, title, color, repeat, due_at, overdue }>`, where `title` is "Private note" for a private note while the lock is engaged.
- Event `reminders-changed`. Its payload carries no titles.
- **Scheduler:**
  - A thread wakes at `next_wake`, or within 60 s at most, to absorb clock and time-zone changes (my call: a 60 s cap).
  - It also wakes immediately on any reminder change, at start and on resume. Reuse the existing logind `PrepareForSleep` watcher from the privacy lock.
  - For each due reminder it sends a notification, then `mark_fired`.
  - At start it sends at most 5, plus one summary "N more reminders" when there are more.
- **Notification:**
  - App name "DeskNotes"; summary = the title, or "Private note" while locked; no body.
  - Actions "10 min", "1 h", "Tomorrow", "Dismiss", plus a default action that opens the note.
  - Action results call `snooze_reminder` or `dismiss_reminder`, then emit `reminders-changed`.
  - The default action calls the existing open-note path.
  - If the notification service is unavailable, log one line without the title, and the reminder stays overdue.
- **Tests:**
  - Rust tests for the summary text (`locked_note_notification_has_no_title`, `private_unlocked_shows_title`);
  - the start-up burst limit (pure function `startup_batch(due, limit=5) -> (send, more_count)`);
  - command validation.
  - The real D-Bus send is checked in Task 6.

- [ ] **Steps:** write the failing tests → FAIL → implement → PASS + full gate → commit `feat(reminders): scheduler, desktop notifications and commands`.

### Task 4: Note UI — "Set reminder…", R1 popover, B2 chip

**Files:**
- `src/features/notes/ReminderPopover.tsx` (new) and its test;
- `src/features/notes/NoteWindow.tsx` (menu item, chip, popover state);
- `src/features/notes/reminderText.ts` (new: chip text, pure) and its test;
- `src/styles/note.css`;
- `src/dev/preview.tsx` (mocks for the four commands, the event, and a `?w=note&reminder=1` state).

**Interfaces:** consumes Task 3's TS commands and event. Produces:
- `chipText(dueAt: number, now: Date): string`, using the spec's formats;
- `ReminderPopover({ noteId, initial, onClose })`.

**Layout and copy follow R1 and B2.** The design markup for R1, R2 and R3 is extracted to `.superpowers/sdd/<plan>/design-r.html` by the controller.
- **Defaults:** the next whole hour, or 09:00 tomorrow after 21:00.
- **Refusal:** shows "Pick a time in the future." inline.
- **Chip:** shows the overdue style when overdue; it hides at narrow widths together with the date. Clicking it opens the popover.

- [ ] **Steps:** failing tests first:
  - `chipText` for today, the next 6 days, later, another year, and overdue;
  - the menu item opens the popover;
  - Save sends the date, time and repeat;
  - Remove removes;
  - the refusal message appears;
  - the chip appears and refreshes on `reminders-changed`.

  Then FAIL → implement → PASS + gate → preview check against R1 and B2 → commit `feat(notes): set a reminder from the note (designs R1, B2)`.

### Task 5: Manager — Reminders tab (R2)

**Files:** `src/features/manager/ManagerWindow.tsx` and its test, `src/features/manager/RemindersList.tsx` (new) and its test, `src/styles/manager.css`, `src/dev/preview.tsx`.

**Interfaces:** consumes `list_reminders` and `reminders-changed`.
- The tab goes between Active and Archived, with a count.
- Groups are "Today" (overdue first), "Tomorrow" and "Later".
- Rows show the colour dot, title, repeat label and the bell with the time or "Overdue · HH:MM". The overdue style follows R2.
- Clicking a row opens the note.
- Search filters by title.

- [ ] **Steps:** failing tests first:
  - grouping across midnight;
  - overdue first;
  - `locked rows show Private note` (the command returns it; the UI renders what it gets);
  - clicking opens;
  - search.

  Then FAIL → implement → PASS + gate → preview check against R2 → commit `feat(manager): Reminders tab (design R2)`.

### Task 6: Real-app verification and docs

**Files:** `docs/testing/m4-reminders-verification.md`, `CHANGELOG.md`.

- [ ] Build a release binary and run it on scratch data, with the owner's agreement to quit their DeskNotes.
- [ ] Check:
  - set a reminder 2 minutes ahead in the scratch database and see the real GNOME notification (title, buttons);
  - snooze 10 min → the due time moves;
  - Dismiss on a one-off and on a repeat;
  - a reminder due while the app is closed fires once at start, and not again after a second restart;
  - the manager tab and the chip;
  - a private locked note shows "Private note".
- [ ] Write the testing doc and the CHANGELOG entry. Commit `docs: reminders verification and changelog`.
