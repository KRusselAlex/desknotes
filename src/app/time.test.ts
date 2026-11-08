import { dateGroup, doneDateLabel, listDateLabel, noteDateLabel } from "./time";

const now = new Date(2026, 10, 1, 15, 0).getTime(); // Sun 1 Nov 2026, 15:00 local

// In the machine's locale: its digits and calendar vary (٢٠٢٥ in Arabic, 2568 in Thai).
const year = (ms: number) =>
  new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: "numeric" })
    .formatToParts(ms)
    .find((p) => p.type === "year")!.value;
const clock = (ms: number) => new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(ms);

describe("time labels", () => {
  it("labels the note header chip", () => {
    expect(noteDateLabel(now - 10_000, now)).toBe("Just now");
    const nineOFive = new Date(2026, 10, 1, 9, 5).getTime();
    expect(noteDateLabel(nineOFive, now)).toBe(`Today ${clock(nineOFive)}`);
    expect(noteDateLabel(new Date(2026, 9, 31, 9, 5).getTime(), now)).toMatch(/^Yesterday /);
    expect(noteDateLabel(new Date(2026, 9, 12).getTime(), now)).not.toContain(year(now));
    const lastYear = new Date(2025, 0, 2).getTime();
    expect(noteDateLabel(lastYear, now)).toContain(year(lastYear));
  });

  it("labels manager rows", () => {
    expect(listDateLabel(new Date(2026, 9, 31, 8).getTime(), now)).toBe("Yesterday");
    const lastYear = new Date(2025, 0, 2).getTime();
    expect(listDateLabel(lastYear, now)).toContain(year(lastYear));
  });

  it("labels the Completed rows with a lower-case yesterday only there", () => {
    expect(doneDateLabel(new Date(2026, 9, 31, 8).getTime(), now)).toBe("Done yesterday");
    expect(listDateLabel(new Date(2026, 9, 31, 8).getTime(), now)).toBe("Yesterday");
    const today = new Date(2026, 10, 1, 9, 5).getTime();
    expect(doneDateLabel(today, now)).toBe(`Done ${listDateLabel(today, now)}`);
    const weekday = new Date(2026, 9, 28).getTime();
    expect(doneDateLabel(weekday, now)).toBe(`Done ${listDateLabel(weekday, now)}`);
    expect(doneDateLabel(new Date(2025, 0, 2).getTime(), now)).toBe(`Done ${listDateLabel(new Date(2025, 0, 2).getTime(), now)}`);
  });

  it("groups by recency", () => {
    expect(dateGroup(now - 1000, now)).toBe("Today");
    expect(dateGroup(new Date(2026, 9, 31).getTime(), now)).toBe("Yesterday");
    expect(dateGroup(new Date(2026, 9, 28).getTime(), now)).toBe("This week");
    expect(dateGroup(new Date(2026, 9, 1).getTime(), now)).toBe("Older");
  });
});
