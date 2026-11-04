# Reminders — design (Milestone 4, DES-36)

Date: 2026-11-04 · Jira: DES-36 (parent DES-5)

**Sources**
- Owner's Claude Design export "DeskNotes Lock Settings Reminders":
  - **C · R1** Set reminder in a note;
  - **C · R2** Manager · Reminders tab;
  - **C · R3** Desktop notification.
- "DeskNotes Note Window": **B · B2**, the reminder chip in the header.
- `docs/design.md` §6, M4: "due dates, reminders (UTC storage, time-zone & DST tests), recurrence, snooze, notification overview".

**Owner decision (2026-11-04):** the notification shows the note's **title**, as drawn in R3. While the note is locked it shows "Private note". This is recorded in CLAUDE.md.

The owner skipped the question round. Everything not in the designs, the brief or that decision is marked **(my call)**.

## 1. Intent

A note can remind you of itself at a set time — once, or on a repeat. DeskNotes shows a desktop notification at that time with quick snooze buttons. The manager lists every coming and missed reminder in one place. All of it is offline: the notification comes from the local desktop, never a server.

## 2. Goals, non-goals, anti-goals

### Goals
- **One reminder per note** (my call: R1 edits a single reminder).
  - It has a date, a time and a repeat: None, Daily, Weekdays, Weekly or Monthly (R1).
  - It is set, changed or removed from the note.
- **Bell chip** in the note header showing when the reminder is due, e.g. "Tue 14:00" (B2). Clicking it opens the reminder popover (R1).
- **At the due time**, a desktop notification appears as R3:
  - "DeskNotes · now" and the note title, or "Private note" while locked, with a lock icon;
  - buttons **10 min**, **1 h**, **Tomorrow** and **Dismiss**;
  - clicking the notification itself opens the note (my call).
- **Manager, Reminders tab** (R2):
  - groups **Today**, **Tomorrow** and **Later**;
  - each row shows the note colour, title, repeat and time;
  - a due-and-not-dismissed row shows **"Overdue · 09:30"** on a danger chip and background;
  - clicking a row opens the note.
- **Repeats** keep the wall-clock time across time-zone and DST changes: 14:00 stays 14:00.
- **Missed reminders** are still shown. If DeskNotes was not running at the due time, the notification appears at the next start, and the row shows Overdue until dismissed.

### Non-goals
- The **Completed** tab in R2, which belongs to tasks (another M4 item). The Reminders tab sits after Active for now (my call).
- Several reminders per note, custom repeat rules (every 2 weeks, the last Friday) and sounds.
- Waking the computer or running without DeskNotes. Reminders fire while DeskNotes runs, and "Launch at login" already exists.

### Anti-goals
- A reminder that never fires, or fires twice for the same occurrence.
- Note **body** text in a notification or log. Only the title is shown, as decided above.
- Any network use.
- A locked private note's title shown anywhere.

## 3. Behaviour

### 3.1 Setting a reminder (R1)
- **Opening the popover:** from the note's ⋯ menu item **"Set reminder…"** (icon `bell`), placed after "Always on top" (my call; R1 does not show how a first reminder is set), or by clicking the bell chip.
- **Contents of the popover**, as R1:
  - the date and the time;
  - **Repeat** as a segmented control: None, Daily, Weekdays, Weekly, Monthly;
  - **Remove** (only when a reminder exists) and **Save**.
- **Defaults for a new reminder** (my call): the next whole hour today, or 09:00 tomorrow if that is after 21:00. Repeat None.
- **Date and time fields:** a native date input and a 24-hour time input (my call: the system shows its own picker; nothing new to design). Saving a time in the past is allowed only with a repeat. A one-off in the past is refused with "Pick a time in the future." (my call).
- **Where it is allowed:** read-only notes can still have reminders (my call: a reminder is not an edit of the text). A locked private note's menu is not reachable, as today.

### 3.2 The chip (B2)
- Shown in the header whenever the note has a reminder: bell icon plus a short time.
  - Today: "14:00".
  - The next 6 days: "Tue 14:00".
  - Later: "4 Nov". From another year: "4 Nov 2027".
- Overdue: the chip turns danger-coloured with the time, as the R2 overdue chip.
- The chip stays visible while reading, like the pin (B2). It hides with the date when the note is narrow (my call: "Date hides first", N12).

### 3.3 Firing and the notification (R3)
- A scheduler in the native app wakes for the next due reminder. It recomputes after any change, at start and after the computer resumes from sleep (my call).
- At the due time it sends one notification per reminder.
  - It shows the app name, the title (or "Private note" plus the lock icon while locked), the four action buttons and the default action "open the note".
  - It uses the desktop's standard notification service. Where action buttons are not supported, only the body click works.
- **Buttons:**
  - **10 min**, **1 h**: snooze to now + 10 min / + 1 h.
  - **Tomorrow:** the same wall-clock time tomorrow (my call).
  - **Dismiss:** a one-off reminder is finished and removed; a repeating one moves to its next occurrence.
  - **Closing** the notification without a choice leaves it **Overdue** (my call), so it shows in the manager and on the chip until dismissed there or rescheduled.
- **Duplicates:** a reminder that has fired is not sent again for the same occurrence after a restart. The core records the occurrence it fired.
- **Missed at start:** reminders due while DeskNotes was closed are sent once at start, at most 5 at once; the rest become one summary notification, "3 more reminders" (my call).
- **Trash:** a note in the trash never fires; its reminder is kept and fires again if the note is restored. Archived notes still fire (my call). Purging a note deletes its reminder.

### 3.4 Repeats
- Times are kept as the **local wall-clock time** the user picked, plus the rule. The next occurrence is computed in the computer's current time zone and stored as UTC.
  - **Daily:** every day.
  - **Weekdays:** Monday to Friday.
  - **Weekly:** the same weekday.
  - **Monthly:** the same day of the month, or the month's last day when it is shorter (31 → 30, 28 or 29) (my call).
- **DST:**
  - A time that does not exist on a spring-forward day fires at the first valid minute after it.
  - A time that occurs twice on a fall-back day fires once, at the first.
- Changing the time zone keeps the wall-clock time.

### 3.5 Manager, Reminders tab (R2)
- A tab "Reminders" with a count, like the others, between Active and Archived.
- Lists every reminder on non-trashed notes, sorted by due time, grouped Today / Tomorrow / Later. Overdue rows sit at the top of Today.
- Each row shows:
  - the note colour dot and the title ("Private note" while locked);
  - the repeat name when not None ("Weekdays");
  - the bell and the time: "14:00" today and tomorrow, "1 Dec" later, "Overdue · 09:30" when overdue.
- Clicking a row opens and focuses the note.
- Search in the manager applies to this tab too (by title), as on other tabs (my call).

## 4. Data

- Appended migration **v6**:

  ```sql
  reminders(
    note_id TEXT PRIMARY KEY REFERENCES notes(id) ON DELETE CASCADE,
    local_date TEXT,      -- "2026-11-04", the date the user picked
    local_time TEXT,      -- "14:00"
    repeat TEXT,          -- "none" | "daily" | "weekdays" | "weekly" | "monthly"
    due_at INTEGER,       -- next occurrence, UTC ms
    snoozed_until INTEGER NULL,
    fired_at INTEGER NULL -- UTC ms of the occurrence already notified
  )
  ```

  - No existing data changes.
  - Every value is validated in Rust: date and time formats, the repeat names, due_at within ±100 years.
- **Backup format 4** adds the reminders. Formats 1–3 still import, without reminders. Duplicate does **not** copy a reminder (my call: two notifications for the same thing is noise).
- **The core owns all time logic,** as pure functions tested without a clock:
  - next occurrence;
  - snooze;
  - dismiss;
  - "is overdue";
  - the start-up catch-up list.

  The current time and time zone are passed in. Tests cover DST gaps and overlaps (Europe/Paris), month ends, leap years, and a time-zone change.

## 5. Constraints

- No network.
  - Notifications use the local desktop notification service over D-Bus, with a pure-Rust client (the builder picks, MIT/Apache, pinned, listed in `docs/design.md` §2).
  - `tauri-plugin-notification` may be used only if it supports action buttons on Linux. Otherwise use the pure-Rust client.
- All SQL lives in the core; `src/ipc` is the only `invoke` caller.
- Notifications show only the title, as decided. Logs never show titles.
- Tokens and icons come from `tokens.css` and `icons.ts`; `bell` exists.
- Real-app checks are recorded in `docs/testing/`, including a notification seen on the GNOME desktop and its buttons.

## 6. Left to the builder

- The scheduler's shape: a thread with a condition variable or timer, as long as it recomputes on change, start and resume.
- The command names and the event that refreshes the chip and the manager after a fire, snooze or dismiss.
- Which D-Bus notification crate to use.
