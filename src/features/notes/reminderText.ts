// What the reminder chip and the popover show, computed in local time. Pure: the clock
// is passed in. English names, 24-hour times, as the rest of the interface.

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const pad = (n: number) => String(n).padStart(2, "0");
/** `HH:MM`, 24 h, of a local date. */
export const hhmm = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

/** Whole calendar days from `from`'s date to `to`'s (not 24-hour steps, so DST days count once). */
export function calendarDays(from: Date, to: Date): number {
  const a = Date.UTC(from.getFullYear(), from.getMonth(), from.getDate());
  const b = Date.UTC(to.getFullYear(), to.getMonth(), to.getDate());
  return Math.round((b - a) / 86_400_000);
}

/**
 * The short text of the note's reminder chip (spec §3.2): "14:00" today, "Tue 14:00" for
 * the next 6 days, "4 Nov" later in the year, "4 Nov 2027" in another year. A reminder
 * that is overdue from an earlier day shows its date.
 */
export function chipText(dueAt: number, now: Date): string {
  const due = new Date(dueAt);
  const days = calendarDays(now, due);
  if (days === 0) return hhmm(due);
  if (days >= 1 && days <= 6) return `${WEEKDAYS[due.getDay()]} ${hhmm(due)}`;
  return shortDate(due, now);
}

/** "4 Nov", with the year ("4 Nov 2027") when it is not `now`'s year. */
export function shortDate(due: Date, now: Date): string {
  const date = `${due.getDate()} ${MONTHS[due.getMonth()]}`;
  return due.getFullYear() === now.getFullYear() ? date : `${date} ${due.getFullYear()}`;
}

/** `YYYY-MM-DD` of a local date. */
export function localDate(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * The date and time a new reminder starts with: the next whole hour today, or 09:00
 * tomorrow when that hour would be after 21:00.
 */
export function defaultReminder(now: Date): { date: string; time: string } {
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours() + 1, 0, 0, 0);
  if (calendarDays(now, next) === 0 && next.getHours() <= 21) {
    return { date: localDate(next), time: hhmm(next) };
  }
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  return { date: localDate(tomorrow), time: "09:00" };
}
