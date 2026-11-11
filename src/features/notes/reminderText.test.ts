import { chipText, defaultReminder } from "./reminderText";

// Wednesday 4 November 2026, 10:00 local time.
const NOW = new Date(2026, 10, 4, 10, 0, 0);
const at = (y: number, mo: number, d: number, h: number, mi: number) => new Date(y, mo, d, h, mi).getTime();

describe("chipText", () => {
  it("shows only the time for today", () => {
    expect(chipText(at(2026, 10, 4, 14, 0), NOW)).toBe("14:00");
    expect(chipText(at(2026, 10, 4, 0, 5), NOW)).toBe("00:05");
    expect(chipText(at(2026, 10, 4, 23, 59), NOW)).toBe("23:59");
  });

  it("adds the weekday for the next 6 days", () => {
    expect(chipText(at(2026, 10, 5, 9, 30), NOW)).toBe("Thu 09:30");
    expect(chipText(at(2026, 10, 10, 14, 0), NOW)).toBe("Tue 14:00");
  });

  it("shows the date from the 7th day on, in the same year", () => {
    expect(chipText(at(2026, 10, 11, 14, 0), NOW)).toBe("11 Nov");
    expect(chipText(at(2026, 11, 25, 8, 0), NOW)).toBe("25 Dec");
  });

  it("adds the year for another year", () => {
    expect(chipText(at(2027, 10, 4, 14, 0), NOW)).toBe("4 Nov 2027");
    expect(chipText(at(2027, 0, 2, 14, 0), NOW)).toBe("2 Jan 2027");
  });

  it("keeps showing the time of an overdue reminder from today, and the date of an older one", () => {
    expect(chipText(at(2026, 10, 4, 9, 30), NOW)).toBe("09:30");
    expect(chipText(at(2026, 10, 3, 9, 30), NOW)).toBe("3 Nov");
    expect(chipText(at(2025, 11, 31, 9, 30), NOW)).toBe("31 Dec 2025");
  });

  it("counts days on the calendar, not in 24 hour steps", () => {
    const lateNow = new Date(2026, 10, 4, 23, 30);
    expect(chipText(at(2026, 10, 5, 0, 10), lateNow)).toBe("Thu 00:10");
    expect(chipText(at(2026, 10, 11, 0, 10), lateNow)).toBe("11 Nov");
  });
});

describe("defaultReminder", () => {
  it("is the next whole hour today", () => {
    expect(defaultReminder(new Date(2026, 10, 4, 10, 15))).toEqual({ date: "2026-11-04", time: "11:00" });
    expect(defaultReminder(new Date(2026, 10, 4, 10, 0, 0))).toEqual({ date: "2026-11-04", time: "11:00" });
    expect(defaultReminder(new Date(2026, 10, 4, 0, 10))).toEqual({ date: "2026-11-04", time: "01:00" });
  });

  it("may be 21:00 itself", () => {
    expect(defaultReminder(new Date(2026, 10, 4, 20, 40))).toEqual({ date: "2026-11-04", time: "21:00" });
  });

  it("is 09:00 tomorrow when the next hour would be after 21:00", () => {
    expect(defaultReminder(new Date(2026, 10, 4, 21, 0))).toEqual({ date: "2026-11-05", time: "09:00" });
    expect(defaultReminder(new Date(2026, 10, 4, 23, 30))).toEqual({ date: "2026-11-05", time: "09:00" });
    expect(defaultReminder(new Date(2026, 11, 31, 22, 10))).toEqual({ date: "2027-01-01", time: "09:00" });
  });
});

describe("chipText across a daylight-saving change and the new year", () => {
  beforeAll(() => {
    vi.stubEnv("TZ", "Europe/Paris"); // Node reads TZ again when it is set
  });
  afterAll(() => {
    vi.unstubAllEnvs();
  });

  it("counts the 23-hour and 25-hour days as one day each", () => {
    // Clocks go forward at 02:00 on 29 March 2026 and back at 03:00 on 25 October.
    expect(new Date(2026, 2, 29, 12).getTimezoneOffset()).toBe(-120);
    expect(chipText(at(2026, 2, 29, 23, 30), new Date(2026, 2, 29, 0, 30))).toBe("23:30");
    expect(chipText(at(2026, 2, 29, 9, 0), new Date(2026, 2, 28, 22, 0))).toBe("Sun 09:00");
    expect(chipText(at(2026, 9, 25, 23, 50), new Date(2026, 9, 25, 0, 10))).toBe("23:50");
    expect(chipText(at(2026, 9, 25, 23, 30), new Date(2026, 9, 24, 23, 30))).toBe("Sun 23:30");
    expect(chipText(at(2026, 9, 31, 9, 0), new Date(2026, 9, 24, 23, 30))).toBe("31 Oct");
  });

  it("names the weekday into the new year, then the date with its year", () => {
    const newYearsEve = new Date(2026, 11, 31, 22, 0);
    expect(chipText(at(2027, 0, 1, 9, 0), newYearsEve)).toBe("Fri 09:00");
    expect(chipText(at(2027, 0, 6, 9, 0), newYearsEve)).toBe("Wed 09:00");
    expect(chipText(at(2027, 0, 8, 9, 0), newYearsEve)).toBe("8 Jan 2027");
    // Overdue since the old year, seen on New Year's Day.
    expect(chipText(at(2026, 11, 31, 14, 0), new Date(2027, 0, 1, 9, 0))).toBe("31 Dec 2026");
  });
});
