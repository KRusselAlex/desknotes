// Display formatting for timestamps (stored as Unix ms UTC, shown in local time).

const DAY = 24 * 60 * 60 * 1000;

function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

const time = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });
const weekday = new Intl.DateTimeFormat(undefined, { weekday: "short" });
const dayMonth = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" });
const dayMonthYear = new Intl.DateTimeFormat(undefined, {
  day: "numeric",
  month: "short",
  year: "numeric",
});

function daysAgo(ms: number, now: number): number {
  return Math.round((startOfDay(now) - startOfDay(ms)) / DAY);
}

function dateOnly(ms: number, now: number): string {
  const sameYear = new Date(ms).getFullYear() === new Date(now).getFullYear();
  return (sameYear ? dayMonth : dayMonthYear).format(ms);
}

/** Chip in the note header: "Just now", "Today 14:32", "Yesterday 09:10", "Mon 09:10", "12 Oct". */
export function noteDateLabel(ms: number, now = Date.now()): string {
  if (now - ms < 60_000 && now >= ms) return "Just now";
  const days = daysAgo(ms, now);
  if (days === 0) return `Today ${time.format(ms)}`;
  if (days === 1) return `Yesterday ${time.format(ms)}`;
  if (days > 1 && days < 7) return `${weekday.format(ms)} ${time.format(ms)}`;
  return dateOnly(ms, now);
}

/** Manager rows: "14:32", "Yesterday", "Thu", "30 Oct", "2 Jan 2025". */
export function listDateLabel(ms: number, now = Date.now()): string {
  const days = daysAgo(ms, now);
  if (days === 0) return time.format(ms);
  if (days === 1) return "Yesterday";
  if (days > 1 && days < 7) return weekday.format(ms);
  return dateOnly(ms, now);
}

/** Completed rows: "Done 14:32", "Done yesterday" (lower case mid-sentence), "Done Thu", "Done 30 Oct". */
export function doneDateLabel(ms: number, now = Date.now()): string {
  if (daysAgo(ms, now) === 1) return "Done yesterday";
  return `Done ${listDateLabel(ms, now)}`;
}

export type DateGroup = "Today" | "Yesterday" | "This week" | "This month" | "Older";

/** Group heading for long lists. */
export function dateGroup(ms: number, now = Date.now()): DateGroup {
  const days = daysAgo(ms, now);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return "This week";
  const d = new Date(ms);
  const n = new Date(now);
  if (d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth()) return "This month";
  return "Older";
}
