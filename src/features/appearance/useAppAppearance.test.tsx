import { act, renderHook, waitFor } from "@testing-library/react";
import { APP_APPEARANCE_DEFAULTS, type AppAppearance } from "../../types/note";

let handler: ((a: AppAppearance) => void) | undefined;
let resolveListen: (() => void) | undefined;
let listenFails = false;
const unlisten = vi.fn();
vi.mock("../../ipc/events", () => ({
  onAppAppearanceChanged: (h: (a: AppAppearance) => void) => {
    handler = h;
    if (listenFails) return Promise.reject(new Error("no events here"));
    return new Promise<() => void>((resolve) => {
      resolveListen = () => resolve(unlisten);
    });
  },
}));
vi.mock("../../ipc/commands", () => ({ commands: { getAppAppearance: vi.fn() } }));

import { commands } from "../../ipc/commands";
import { useAppAppearance } from "./useAppAppearance";

const look = (over: Partial<AppAppearance> = {}): AppAppearance => ({ ...APP_APPEARANCE_DEFAULTS, ...over });

describe("useAppAppearance", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    handler = undefined;
    resolveListen = undefined;
    listenFails = false;
  });

  it("reads only once the listener is registered, so no change is missed in between", async () => {
    vi.mocked(commands.getAppAppearance).mockResolvedValue(look({ defaultSize: 18 }));
    const { result } = renderHook(() => useAppAppearance());
    await act(async () => undefined);
    expect(commands.getAppAppearance).not.toHaveBeenCalled();
    expect(result.current).toBeNull();
    await act(async () => resolveListen?.());
    await waitFor(() => expect(result.current).toEqual(look({ defaultSize: 18 })));
  });

  it("keeps a change that arrives before the read answers", async () => {
    let answer: ((a: AppAppearance) => void) | undefined;
    vi.mocked(commands.getAppAppearance).mockReturnValue(new Promise((resolve) => (answer = resolve)));
    const { result } = renderHook(() => useAppAppearance());
    await act(async () => resolveListen?.());
    await waitFor(() => expect(commands.getAppAppearance).toHaveBeenCalled());
    act(() => handler?.(look({ highContrast: true })));
    await act(async () => answer?.(look()));
    expect(result.current).toEqual(look({ highContrast: true }));
  });

  it("gives the defaults when the read fails, and still reads when listening fails", async () => {
    listenFails = true;
    vi.mocked(commands.getAppAppearance).mockRejectedValue(new Error("no app"));
    const { result } = renderHook(() => useAppAppearance());
    await waitFor(() => expect(result.current).toEqual(APP_APPEARANCE_DEFAULTS));
  });

  it("stops listening when unmounted", async () => {
    vi.mocked(commands.getAppAppearance).mockResolvedValue(look());
    const { unmount } = renderHook(() => useAppAppearance());
    await act(async () => resolveListen?.());
    unmount();
    await waitFor(() => expect(unlisten).toHaveBeenCalled());
  });
});
