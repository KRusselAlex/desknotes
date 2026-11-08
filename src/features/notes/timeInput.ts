// Reading a time as people type it, for the reminder popover. WebKitGTK's native
// `<input type="time">` never moves on from the hour, so typing "0930" there gave "12:00".

const pad = (n: number) => String(n).padStart(2, "0");

/**
 * The typed time as "HH:MM" (24-hour), or null when it is not one. Takes "14:00", "9:30",
 * "0930", "930", "9", "9.30", "9h30", and 12-hour forms such as "9pm", "9:30 p.m." or "12am".
 * Minutes always have two digits ("9:3" is refused).
 */
export function parseTime(text: string): string | null {
  const m = /^\s*(\d{1,2})(?:[:.h ]?(\d{2}))?\s*(?:([ap])\.?\s*m?\.?)?\s*$/i.exec(text);
  if (!m) return null;
  let hour = Number(m[1]);
  const minute = m[2] ? Number(m[2]) : 0;
  if (minute > 59) return null;
  const period = m[3]?.toLowerCase();
  if (period) {
    if (hour < 1 || hour > 12) return null;
    hour = (hour % 12) + (period === "p" ? 12 : 0);
  } else if (hour > 23) {
    return null;
  }
  return `${pad(hour)}:${pad(minute)}`;
}
