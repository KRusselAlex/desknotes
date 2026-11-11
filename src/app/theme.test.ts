import { followSystemTheme } from "./theme";

/** A system that prefers dark, and can switch. */
function systemDark(initially: boolean) {
  let listener: (() => void) | null = null;
  const query = {
    matches: initially,
    addEventListener: (_: string, l: () => void) => (listener = l),
  };
  vi.stubGlobal("matchMedia", () => query);
  return {
    set(dark: boolean) {
      query.matches = dark;
      listener?.();
    },
  };
}

describe("followSystemTheme", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    document.documentElement.removeAttribute("data-theme");
  });

  it("follows the system in an app window, and its changes", () => {
    const system = systemDark(true);
    followSystemTheme();
    expect(document.documentElement.dataset.theme).toBe("dark");
    system.set(false);
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("keeps a note window light under a dark system theme, even when it changes", () => {
    const system = systemDark(true);
    followSystemTheme(true);
    expect(document.documentElement.dataset.theme).toBe("light");
    system.set(true);
    expect(document.documentElement.dataset.theme).toBe("light");
  });
});
