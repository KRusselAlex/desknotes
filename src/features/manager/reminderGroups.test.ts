import type { ReminderListRow } from "../../types/reminder";
import { groupReminders, reminderWhen, repeatLabel } from "./reminderGroups";

// Wed 4 Nov 2026, 22:30 local: close to midnight so "tomorrow" starts in 90 minutes.
const now = new Date(2026, 10, 4, 22, 30).getTime();
const at = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();

const row = (over: Partial<ReminderListRow> = {}): ReminderListRow => ({
  noteId: "n1",
  title: "Call back",
  color: "#ffd6e0",
  repeat: "none",
  dueAt: at(2026, 11, 4, 23, 0),
  overdue: false,
  locked: false,
  ...over,
});

describe("reminderWhen", () => {
  it("shows the time for today and tomorrow", () => {
    expect(reminderWhen(row({ dueAt: at(2026, 11, 4, 23, 5) }), now)).toBe("23:05");
    expect(reminderWhen(row({ dueAt: at(2026, 11, 5, 0, 15) }), now)).toBe("00:15");
    expect(reminderWhen(row({ dueAt: at(2026, 11, 5, 8, 45) }), now)).toBe("08:45");
  });

  it("shows the date later, with the year only when it is not this year", () => {
    expect(reminderWhen(row({ dueAt: at(2026, 11, 6, 9, 0) }), now)).toBe("6 Nov");
    expect(reminderWhen(row({ dueAt: at(2026, 12, 1, 9, 0) }), now)).toBe("1 Dec");
    expect(reminderWhen(row({ dueAt: at(2027, 1, 15, 9, 0) }), now)).toBe("15 Jan 2027");
  });

  it("says Overdue with the due time, even when it was due days ago", () => {
    expect(reminderWhen(row({ overdue: true, dueAt: at(2026, 11, 4, 9, 30) }), now)).toBe("Overdue · 09:30");
    expect(reminderWhen(row({ overdue: true, dueAt: at(2026, 11, 2, 8, 0) }), now)).toBe("Overdue · 08:00");
  });
});

describe("repeatLabel", () => {
  it("names the repeat and says nothing for none", () => {
    expect(repeatLabel("none")).toBe("");
    expect(repeatLabel("daily")).toBe("Daily");
    expect(repeatLabel("weekdays")).toBe("Weekdays");
    expect(repeatLabel("weekly")).toBe("Weekly");
    expect(repeatLabel("monthly")).toBe("Monthly");
  });
});

describe("groupReminders", () => {
  it("groups into Today, Tomorrow and Later across midnight", () => {
    const groups = groupReminders(
      [
        row({ noteId: "a", dueAt: at(2026, 11, 4, 23, 59) }),
        row({ noteId: "b", dueAt: at(2026, 11, 5, 0, 0) }),
        row({ noteId: "c", dueAt: at(2026, 11, 5, 23, 59) }),
        row({ noteId: "d", dueAt: at(2026, 11, 6, 0, 0) }),
        row({ noteId: "e", dueAt: at(2027, 1, 15, 9, 0) }),
      ],
      now,
    );
    expect(groups.map((g) => [g.label, g.rows.map((r) => r.noteId)])).toEqual([
      ["Today", ["a"]],
      ["Tomorrow", ["b", "c"]],
      ["Later", ["d", "e"]],
    ]);
  });

  it("moves to the next day when the clock passes midnight", () => {
    const next = at(2026, 11, 5, 0, 5);
    const rows = [row({ noteId: "a", dueAt: at(2026, 11, 5, 9, 0) })];
    expect(groupReminders(rows, now).map((g) => g.label)).toEqual(["Tomorrow"]);
    expect(groupReminders(rows, next).map((g) => g.label)).toEqual(["Today"]);
  });

  it("puts overdue rows first in Today, oldest first, then the rest by time", () => {
    const groups = groupReminders(
      [
        row({ noteId: "later-today", dueAt: at(2026, 11, 4, 23, 0) }),
        row({ noteId: "overdue-today", overdue: true, dueAt: at(2026, 11, 4, 9, 30) }),
        row({ noteId: "overdue-days", overdue: true, dueAt: at(2026, 11, 2, 8, 0) }),
        row({ noteId: "later-today-2", dueAt: at(2026, 11, 4, 22, 45) }),
      ],
      now,
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]!.label).toBe("Today");
    expect(groups[0]!.rows.map((r) => r.noteId)).toEqual(["overdue-days", "overdue-today", "later-today-2", "later-today"]);
  });

  it("leaves out groups with no rows and handles an empty list", () => {
    expect(groupReminders([], now)).toEqual([]);
    expect(groupReminders([row({ dueAt: at(2026, 12, 1, 9, 0) })], now).map((g) => g.label)).toEqual(["Later"]);
  });
});
