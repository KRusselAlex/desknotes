import { act, renderHook } from "@testing-library/react";
import type { ReminderView } from "../../types/reminder";

vi.mock("../../ipc/commands", () => ({
  commands: { getReminder: vi.fn(), getSettings: vi.fn() },
}));
const events = vi.hoisted(() => ({
  reminders: null as ((p: { noteId: string | null }) => void) | null,
  unlisten: vi.fn(),
}));
vi.mock("../../ipc/events", () => ({
  onRemindersChanged: (h: (p: { noteId: string | null }) => void) => {
    events.reminders = h;
    return Promise.resolve(events.unlisten);
  },
  onAutomationsChanged: () => Promise.resolve(() => undefined),
}));

import { commands } from "../../ipc/commands";
import { useReminder } from "./noteHooks";

const view = (dueAt: number) => ({ dueAt }) as unknown as ReminderView;

/** Reads that answer only when told to. */
function pendingReads() {
  const answers: { ok: (v: ReminderView | null) => void; fail: (e: Error) => void }[] = [];
  vi.mocked(commands.getReminder).mockImplementation(
    () => new Promise((ok, fail) => answers.push({ ok, fail })),
  );
  return answers;
}

describe("useReminder", () => {
  beforeEach(() => {
    vi.mocked(commands.getReminder).mockReset();
    events.unlisten.mockReset();
    events.reminders = null;
  });
  afterEach(() => vi.useRealTimers());

  it("ignores a read that answers after a newer one", async () => {
    const answers = pendingReads();
    const { result } = renderHook(() => useReminder("n1"));
    await act(async () => events.reminders?.({ noteId: "n1" }));
    expect(answers).toHaveLength(2);
    await act(async () => answers[1]!.ok(view(2)));
    expect(result.current).toEqual(view(2));
    await act(async () => answers[0]!.ok(view(1)));
    expect(result.current).toEqual(view(2));
  });

  it("keeps what is shown when a read fails, and still takes an older read that succeeds", async () => {
    const answers = pendingReads();
    const { result } = renderHook(() => useReminder("n1"));
    await act(async () => answers[0]!.ok(view(1)));
    await act(async () => events.reminders?.({ noteId: null }));
    await act(async () => events.reminders?.({ noteId: "n1" }));
    await act(async () => answers[2]!.fail(new Error("busy")));
    expect(result.current).toEqual(view(1));
    // Older than the failed read, but newer than what is shown (the reminder was removed).
    await act(async () => answers[1]!.ok(null));
    expect(result.current).toBeNull();
  });

  it("reads only for its own note's changes", async () => {
    const answers = pendingReads();
    renderHook(() => useReminder("n1"));
    await act(async () => events.reminders?.({ noteId: "n2" }));
    expect(answers).toHaveLength(1);
  });

  it("stops reading, listening and ticking once unmounted", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const answers = pendingReads();
    const { result, unmount } = renderHook(() => useReminder("n1"));
    await act(async () => undefined); // the listener is registered
    unmount();
    await act(async () => answers[0]!.ok(view(1)));
    expect(result.current).toBeNull();
    expect(events.unlisten).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTimeAsync(5 * 60_000));
    expect(answers).toHaveLength(1);
  });
});
