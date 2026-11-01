import { Autosave, type SaveState } from "./autosave";

function deferred() {
  let resolve!: () => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("Autosave", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function setup(save = vi.fn<(c: string) => Promise<void>>().mockResolvedValue(undefined)) {
    const states: SaveState[] = [];
    const autosave = new Autosave({
      save,
      onStateChange: (s) => states.push(s),
      debounceMs: 500,
      maxWaitMs: 2000,
    });
    return { autosave, save, states };
  }

  it("waits for a pause in typing, then writes once", async () => {
    const { autosave, save } = setup();
    autosave.change("a");
    autosave.change("ab");
    await vi.advanceTimersByTimeAsync(499);
    expect(save).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith("ab");
    expect(autosave.currentState).toBe("saved");
  });

  it("still saves during continuous typing (max wait)", async () => {
    const { autosave, save } = setup();
    for (let t = 0; t < 2000; t += 100) {
      autosave.change(`text ${t}`);
      await vi.advanceTimersByTimeAsync(100);
    }
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenLastCalledWith("text 1900");
  });

  it("flush writes immediately and resolves after the write", async () => {
    const { autosave, save } = setup();
    autosave.change("now");
    await autosave.flush();
    expect(save).toHaveBeenCalledWith("now");
    expect(autosave.hasUnsavedChanges).toBe(false);
  });

  it("never runs two saves at once and writes the newest content next", async () => {
    const first = deferred();
    const save = vi
      .fn<(c: string) => Promise<void>>()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValue(undefined);
    const { autosave } = setup(save);

    autosave.change("v1");
    void autosave.flush();
    autosave.change("v2");
    autosave.change("v3");
    const done = autosave.flush();
    expect(save).toHaveBeenCalledTimes(1);

    first.resolve();
    await done;
    expect(save.mock.calls.map((c) => c[0])).toEqual(["v1", "v3"]);
    expect(autosave.currentState).toBe("saved");
  });

  it("keeps content after a failure and recovers on retry", async () => {
    const save = vi
      .fn<(c: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error("disk full"))
      .mockResolvedValue(undefined);
    const errors: string[] = [];
    const autosave = new Autosave({
      save,
      onStateChange: (s, e) => s === "error" && errors.push(e ?? ""),
    });

    autosave.change("precious");
    await autosave.flush();
    expect(autosave.currentState).toBe("error");
    expect(errors).toEqual(["disk full"]);
    expect(autosave.hasUnsavedChanges).toBe(true);

    await autosave.flush();
    expect(save).toHaveBeenLastCalledWith("precious");
    expect(autosave.currentState).toBe("saved");
  });

  it("prefers newer edits over failed older content", async () => {
    const failing = deferred();
    const save = vi
      .fn<(c: string) => Promise<void>>()
      .mockReturnValueOnce(failing.promise)
      .mockResolvedValue(undefined);
    const { autosave } = setup(save);

    autosave.change("old");
    const first = autosave.flush();
    autosave.change("new");
    failing.reject(new Error("busy"));
    await first;
    await autosave.flush();
    expect(save).toHaveBeenLastCalledWith("new");
    expect(save).not.toHaveBeenCalledTimes(3);
  });

  it("does nothing when there is nothing to save", async () => {
    const { autosave, save, states } = setup();
    await autosave.flush();
    expect(save).not.toHaveBeenCalled();
    expect(states).toEqual(["saved"]);
  });
});
