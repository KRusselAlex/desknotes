// Mirrors the serde types in src-tauri/src/commands/reminders.rs and
// crates/desknotes-core/src/reminders.rs. Keep both sides in sync.

/** How a reminder repeats (stored and sent as these names). */
export type Repeat = "none" | "daily" | "weekdays" | "weekly" | "monthly";

/** A note's reminder (`get_reminder`, `set_reminder`). */
export interface ReminderView {
  /** The date the person picked, `YYYY-MM-DD`. */
  date: string;
  /** The time the person picked, `HH:MM`, 24 h. */
  time: string;
  repeat: Repeat;
  /** When it is next due (Unix ms): the snooze if there is one, else the occurrence. */
  dueAt: number;
  overdue: boolean;
}

/** One row of the manager's Reminders tab (`list_reminders`). */
export interface ReminderListRow {
  noteId: string;
  /** Already "Private note" while the lock withholds the note; "" for an empty note. */
  title: string;
  color: string;
  repeat: Repeat;
  dueAt: number;
  overdue: boolean;
  locked: boolean;
  /** The note is archived: it has no window, so the row opens the Archived tab. */
  archived: boolean;
}

/** Payload of `reminders-changed`: the note whose reminder changed, or null when
 * several did. Never a title. */
export interface RemindersChanged {
  noteId: string | null;
}
