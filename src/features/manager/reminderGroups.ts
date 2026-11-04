// What the Reminders tab shows (design R2), computed in local time with the clock passed in.
import type { ReminderListRow, Repeat } from "../../types/reminder";
import { calendarDays, hhmm, shortDate } from "../notes/reminderText";

export type ReminderGroupLabel = "Today" | "Tomorrow" | "Later";

export interface ReminderGroup {
  label: ReminderGroupLabel;
  rows: ReminderListRow[];
}

const REPEAT_NAMES: Record<Repeat, string> = {
  none: "",
  daily: "Daily",
  weekdays: "Weekdays",
  weekly: "Weekly",
  monthly: "Monthly",
};

/** "Weekdays" and so on; nothing for a one-off. */
export function repeatLabel(repeat: Repeat): string {
  return REPEAT_NAMES[repeat];
}

/**
 * The time on a row's chip: "14:00" today and tomorrow, "1 Dec" (or "1 Dec 2027") later,
 * "Overdue · 09:30" when overdue, whatever day it was due.
 */
export function reminderWhen(row: ReminderListRow, now: number): string {
  const due = new Date(row.dueAt);
  if (row.overdue) return `Overdue · ${hhmm(due)}`;
  const days = calendarDays(new Date(now), due);
  return days <= 1 ? hhmm(due) : shortDate(due, new Date(now));
}

/**
 * Today, Tomorrow and Later by the local calendar day, empty groups left out. Overdue rows
 * (whenever they were due) sit at the top of Today, oldest first; the rest go by due time.
 */
export function groupReminders(rows: ReminderListRow[], now: number): ReminderGroup[] {
  const today = new Date(now);
  const labelOf = (r: ReminderListRow): ReminderGroupLabel => {
    if (r.overdue) return "Today";
    const days = calendarDays(today, new Date(r.dueAt));
    return days <= 0 ? "Today" : days === 1 ? "Tomorrow" : "Later";
  };
  const sorted = [...rows].sort((a, b) => Number(b.overdue) - Number(a.overdue) || a.dueAt - b.dueAt);
  const groups: ReminderGroup[] = [];
  for (const label of ["Today", "Tomorrow", "Later"] as const) {
    const inGroup = sorted.filter((r) => labelOf(r) === label);
    if (inGroup.length > 0) groups.push({ label, rows: inGroup });
  }
  return groups;
}
