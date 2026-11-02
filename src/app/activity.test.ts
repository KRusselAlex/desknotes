import { ACTIVITY_REPORT_INTERVAL_MS, startActivityReporter } from "./activity";

describe("activity reporter", () => {
  let target: EventTarget & Pick<Window, "addEventListener" | "removeEventListener">;
  let report: ReturnType<typeof vi.fn<() => Promise<unknown>>>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-02T10:00:00Z"));
    target = new EventTarget() as typeof target;
    report = vi.fn<() => Promise<unknown>>().mockResolvedValue(undefined);
  });
  afterEach(() => vi.useRealTimers());

  const input = (type: string) => target.dispatchEvent(new Event(type));

  it("reports pointer, key and wheel input at most once per 30 s", () => {
    const stop = startActivityReporter(report, target);
    expect(ACTIVITY_REPORT_INTERVAL_MS).toBe(30_000);

    input("keydown");
    expect(report).toHaveBeenCalledTimes(1);
    input("pointerdown");
    input("wheel");
    vi.advanceTimersByTime(29_999);
    input("keydown");
    expect(report).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1);
    input("wheel");
    expect(report).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(30_000);
    input("pointerdown");
    expect(report).toHaveBeenCalledTimes(3);
    stop();
  });

  it("ignores other events and stops when asked", () => {
    const stop = startActivityReporter(report, target);
    input("mousemove");
    input("focus");
    expect(report).not.toHaveBeenCalled();
    stop();
    input("keydown");
    expect(report).not.toHaveBeenCalled();
  });

  it("keeps reporting when the clock is moved back", () => {
    const stop = startActivityReporter(report, target);
    input("keydown");
    vi.setSystemTime(new Date("2026-11-02T08:00:00Z"));
    input("keydown");
    expect(report).toHaveBeenCalledTimes(2);
    stop();
  });

  it("never throws when the native side refuses", async () => {
    report.mockRejectedValue(new Error("not in Tauri"));
    const stop = startActivityReporter(report, target);
    expect(() => input("keydown")).not.toThrow();
    await Promise.resolve();
    stop();
  });
});
