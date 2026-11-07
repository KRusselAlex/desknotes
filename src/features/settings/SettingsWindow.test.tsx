import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("../../ipc/commands", () => ({
  commands: {
    getSettings: vi.fn(),
    getToggleShortcut: vi.fn().mockResolvedValue({ available: true, binding: null, label: null }),
    setLaunchAtLogin: vi.fn(),
    setNewNoteColor: vi.fn().mockResolvedValue(undefined),
    setMinNoteSize: vi.fn(),
    setAppAppearance: vi.fn(),
    listFonts: vi.fn().mockResolvedValue(["Atkinson Hyperlegible", "Fira Sans"]),
    openDataFolder: vi.fn().mockResolvedValue(undefined),
    openExternalLink: vi.fn().mockResolvedValue(undefined),
    setRecoveryMethod: vi.fn().mockResolvedValue({ check: { kind: "ok" }, recoveryCode: "K7QD-M2XP-9WTR-4HNB-C6JF-V8LZ" }),
    privacyStatus: vi.fn().mockResolvedValue({
      enabled: true,
      locked: false,
      lockAfterMinutes: 5,
      recovery: "code",
      recoveryMethod: "code",
      systemAvailable: false,
      resetAt: null,
    }),
  },
}));
const events = vi.hoisted(() => ({ section: null as ((name: string) => void) | null }));
vi.mock("../../ipc/events", () => ({
  onPrivacyChanged: () => Promise.resolve(() => undefined),
  onSettingsSection: (h: (name: string) => void) => {
    events.section = h;
    return Promise.resolve(() => undefined);
  },
}));

import { commands } from "../../ipc/commands";
import { parseSection, SettingsWindow } from "./SettingsWindow";

const settings = {
  launchAtLogin: false,
  newNoteColor: "#fff4a3",
  minNoteSize: { width: 180, height: 120 },
  appAppearance: { highContrast: false, layout: "comfortable" as const, defaultFont: null, defaultSize: 15 },
  version: "0.1.0",
  osName: "Ubuntu 24.04 LTS",
  dataDir: "/home/me/.local/share/io.github.krusselalex.desknotes",
  lastBackupAt: null,
  automations: {
    autoCompleteChecklists: false,
    resetChecklistsOnRepeat: false,
    archiveDoneEnabled: false,
    archiveDoneDays: 7,
    purgeTrashEnabled: false,
    purgeTrashDays: 30,
    purgeOffByRestore: false,
  },
};

describe("SettingsWindow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(commands.getSettings).mockResolvedValue(settings);
  });

  it("turns launch at login on and shows the state the system reports", async () => {
    vi.mocked(commands.setLaunchAtLogin).mockResolvedValue(true);
    render(<SettingsWindow />);
    const sw = await screen.findByRole("switch", { name: "Launch at login" });
    expect(sw).toHaveAttribute("aria-checked", "false");
    await userEvent.click(sw);
    expect(commands.setLaunchAtLogin).toHaveBeenCalledWith(true);
    await waitFor(() => expect(sw).toHaveAttribute("aria-checked", "true"));
  });

  it("shows an error and keeps the old state when launch at login cannot change", async () => {
    vi.mocked(commands.setLaunchAtLogin).mockRejectedValue(new Error("Launch at login could not be changed"));
    render(<SettingsWindow />);
    const sw = await screen.findByRole("switch", { name: "Launch at login" });
    await userEvent.click(sw);
    expect(await screen.findByRole("alert")).toHaveTextContent("could not be changed");
    expect(sw).toHaveAttribute("aria-checked", "false");
  });

  it("chooses the colour for new notes", async () => {
    render(<SettingsWindow />);
    await userEvent.click(await screen.findByRole("radio", { name: "Mint" }));
    expect(commands.setNewNoteColor).toHaveBeenCalledWith("#c8f7c5");
    expect(screen.getByRole("radio", { name: "Mint" })).toHaveAttribute("aria-checked", "true");
  });

  it("shows the minimum note size and saves a new width on Enter", async () => {
    vi.mocked(commands.setMinNoteSize).mockResolvedValue({ width: 240, height: 120 });
    render(<SettingsWindow />);
    const width = await screen.findByRole("textbox", { name: "Minimum width" });
    expect(width).toHaveValue("180");
    expect(screen.getByRole("textbox", { name: "Minimum height" })).toHaveValue("120");
    await userEvent.clear(width);
    await userEvent.type(width, "240{Enter}");
    expect(commands.setMinNoteSize).toHaveBeenCalledWith(240, 120);
    expect(width).toHaveValue("240");
  });

  it("saves the minimum height when the field loses focus", async () => {
    vi.mocked(commands.setMinNoteSize).mockResolvedValue({ width: 180, height: 200 });
    render(<SettingsWindow />);
    const height = await screen.findByRole("textbox", { name: "Minimum height" });
    await userEvent.clear(height);
    await userEvent.type(height, "200");
    await userEvent.tab();
    expect(commands.setMinNoteSize).toHaveBeenCalledWith(180, 200);
  });

  it("shows why a minimum size was refused and restores the saved one", async () => {
    vi.mocked(commands.setMinNoteSize).mockRejectedValue(
      new Error("invalid data: minimum note size must be 180–600 × 120–600 px"),
    );
    render(<SettingsWindow />);
    const width = await screen.findByRole("textbox", { name: "Minimum width" });
    await userEvent.clear(width);
    await userEvent.type(width, "900{Enter}");
    expect(await screen.findByRole("alert")).toHaveTextContent("180–600");
    expect(width).toHaveValue("180");
  });

  it("keeps what is being typed in one field when the other one's save returns", async () => {
    let finish: (size: { width: number; height: number }) => void = () => undefined;
    vi.mocked(commands.setMinNoteSize).mockReturnValue(new Promise((resolve) => (finish = resolve)));
    render(<SettingsWindow />);
    const width = await screen.findByRole("textbox", { name: "Minimum width" });
    const height = screen.getByRole("textbox", { name: "Minimum height" });
    await userEvent.clear(width);
    await userEvent.type(width, "240");
    await userEvent.tab(); // saves the width, focus moves to height
    await userEvent.clear(height);
    await userEvent.type(height, "2");
    await act(async () => finish({ width: 240, height: 120 }));
    expect(width).toHaveValue("240");
    expect(height).toHaveValue("2");
  });

  it("never sends a minimum size that is not a number", async () => {
    render(<SettingsWindow />);
    const width = await screen.findByRole("textbox", { name: "Minimum width" });
    await userEvent.clear(width);
    await userEvent.type(width, "abc{Enter}");
    expect(commands.setMinNoteSize).not.toHaveBeenCalled();
    expect(width).toHaveValue("180");
  });

  it("shows version, data folder and the privacy statement in About", async () => {
    render(<SettingsWindow />);
    await userEvent.click(await screen.findByRole("button", { name: "About" }));
    expect(screen.getByText("version 0.1.0")).toBeInTheDocument();
    expect(screen.getByText(/MIT license/)).toBeInTheDocument();
    expect(screen.getByText(settings.dataDir)).toBeInTheDocument();
    expect(screen.getByText(/No data leaves this computer\./)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Open folder" }));
    expect(commands.openDataFolder).toHaveBeenCalled();
  });

  it("lists General, Appearance, Privacy, Backup, About, with Privacy still opening its pane", async () => {
    render(<SettingsWindow />);
    const nav = screen.getByRole("navigation", { name: "Settings sections" });
    expect([...nav.querySelectorAll("button")].map((b) => b.textContent)).toEqual([
      "General",
      "Appearance",
      "Privacy",
      "Backup",
      "About",
    ]);
    await userEvent.click(screen.getByRole("button", { name: "Privacy" }));
    expect(await screen.findByText("Lock private notes with a PIN")).toBeInTheDocument();
  });

  it("knows the sections other windows may open", () => {
    expect(parseSection("privacy")).toEqual({ section: "privacy", newPin: false });
    expect(parseSection("privacy-new-pin")).toEqual({ section: "privacy", newPin: true });
    expect(parseSection("about")).toEqual({ section: "about", newPin: false });
    expect(parseSection("appearance")).toEqual({ section: "appearance", newPin: false });
    for (const bad of [null, undefined, "", "Privacy", "lock", "privacy "]) expect(parseSection(bad)).toBeNull();
  });

  it("opens at the section in its address", async () => {
    window.history.replaceState(null, "", "/?section=privacy");
    try {
      render(<SettingsWindow />);
      expect(screen.getByRole("button", { name: "Privacy" })).toHaveAttribute("aria-current", "page");
      expect(await screen.findByText("Lock private notes with a PIN")).toBeInTheDocument();
    } finally {
      window.history.replaceState(null, "", "/");
    }
  });

  it("switches section when another window asks, and opens choose-a-new-PIN once", async () => {
    render(<SettingsWindow />);
    await waitFor(() => expect(events.section).not.toBeNull());
    act(() => events.section!("privacy-new-pin"));
    expect(screen.getByRole("button", { name: "Privacy" })).toHaveAttribute("aria-current", "page");
    expect(await screen.findByText("Choose a new PIN")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    // Leaving and coming back does not ask again.
    await userEvent.click(screen.getByRole("button", { name: "General" }));
    await userEvent.click(screen.getByRole("button", { name: "Privacy" }));
    expect(await screen.findByText("Lock private notes with a PIN")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).toBeNull();
    act(() => events.section!("nonsense"));
    expect(screen.getByRole("button", { name: "Privacy" })).toHaveAttribute("aria-current", "page");
  });

  it("keeps a recovery code on screen when another window asks for a section, then goes there", async () => {
    render(<SettingsWindow />);
    await waitFor(() => expect(events.section).not.toBeNull());
    await userEvent.click(screen.getByRole("button", { name: "Privacy" }));
    await userEvent.click(await screen.findByRole("button", { name: "New recovery code…" }));
    await userEvent.keyboard("246810");
    expect(await screen.findByText("Save your recovery code")).toBeInTheDocument();
    // Neither a remount ("privacy-new-pin") nor another section drops the code.
    act(() => events.section!("privacy-new-pin"));
    act(() => events.section!("about"));
    expect(screen.getByRole("group", { name: "Recovery code" })).toHaveTextContent("K7QD");
    expect(screen.getByRole("button", { name: "Privacy" })).toHaveAttribute("aria-current", "page");
    // Once it is closed, the last section asked for is shown.
    await userEvent.click(screen.getByRole("checkbox", { name: "I've written it down" }));
    await userEvent.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "About" })).toHaveAttribute("aria-current", "page"));
    expect(screen.queryByText("Save your recovery code")).toBeNull();
  });

  describe("About", () => {
    const openAbout = async () => {
      window.history.replaceState(null, "", "/?section=about");
      render(<SettingsWindow />);
      window.history.replaceState(null, "", "/");
      return screen.findByRole("heading", { name: "About" });
    };
    const clipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    const stubClipboard = (writeText: (text: string) => Promise<void>) =>
      Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    afterEach(() => {
      vi.useRealTimers();
      if (clipboard) Object.defineProperty(navigator, "clipboard", clipboard);
      else delete (navigator as unknown as Record<string, unknown>).clipboard;
    });

    it("shows the header, purpose, credit, links, folder, privacy line and footer in that order", async () => {
      await openAbout();
      const about = document.querySelector(".dn-about") as HTMLElement;
      const header = about.querySelector(".dn-about-head") as HTMLElement;
      expect(header.querySelector("img")).toHaveAttribute("alt", "");
      expect(header).toHaveTextContent("DeskNotes");
      expect(header).toHaveTextContent("version 0.1.0");
      expect(within(header).getByRole("button", { name: "Copy" })).toBeInTheDocument();
      expect(header).toHaveTextContent("MIT license");
      const text = about.textContent ?? "";
      const order = [
        "DeskNotes",
        "version 0.1.0",
        "Copy",
        "MIT license",
        "Sticky notes for your desktop that work offline and keep everything on your computer.",
        "Made by Alex (KRusselAlex) and DeskNotes contributors.",
        "Source code on GitHub",
        "Report a problem or suggest an idea",
        "More free open-source tools by Alex",
        "Your notes are stored in",
        "Open folder",
        "No data leaves this computer. The app never connects to the internet on its own.",
        "Icons derived from Lucide (ISC).",
        "Third-party notices",
        "Licence text",
      ];
      let at = -1;
      for (const part of order) {
        const next = text.indexOf(part, at + 1);
        expect(next, part).toBeGreaterThan(at);
        at = next;
      }
      expect(screen.getByText("Alex", { selector: "strong" })).toBeInTheDocument();
      expect(screen.getAllByText("opens browser")).toHaveLength(3);
    });

    it("ties each browser hint to its link as the description, leaving the names alone", async () => {
      await openAbout();
      for (const name of ["Source code on GitHub", "Report a problem or suggest an idea", "More free open-source tools by Alex"]) {
        const link = screen.getByRole("button", { name });
        expect(link).toHaveAccessibleName(name);
        expect(link).toHaveAccessibleDescription("opens browser");
      }
    });

    it("announces Copied in a polite live region, empty otherwise", async () => {
      stubClipboard(vi.fn().mockResolvedValue(undefined));
      await openAbout();
      const status = screen.getByRole("status");
      expect(status).toHaveAttribute("aria-live", "polite");
      expect(status).toBeEmptyDOMElement();
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      await act(async () => screen.getByRole("button", { name: "Copy" }).click());
      expect(status).toHaveTextContent("Copied");
      act(() => void vi.advanceTimersByTime(2000));
      expect(status).toBeEmptyDOMElement();
    });

    it("copies the version and OS name, and says Copied for 2 s", async () => {
      const writeText = vi.fn().mockResolvedValue(undefined);
      stubClipboard(writeText);
      await openAbout();
      const copy = await screen.findByRole("button", { name: "Copy" });
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      await act(async () => {
        copy.click();
      });
      expect(writeText).toHaveBeenCalledWith("DeskNotes 0.1.0 · Ubuntu 24.04 LTS");
      expect(screen.getByRole("button", { name: "Copied" })).toBeInTheDocument();
      act(() => void vi.advanceTimersByTime(1999));
      expect(screen.getByRole("button", { name: "Copied" })).toBeInTheDocument();
      act(() => void vi.advanceTimersByTime(1));
      expect(screen.getByRole("button", { name: "Copy" })).toBeInTheDocument();
    });

    it("says so when the clipboard refuses", async () => {
      stubClipboard(vi.fn().mockRejectedValue(new Error("denied")));
      await openAbout();
      await userEvent.click(await screen.findByRole("button", { name: "Copy" }));
      expect(await screen.findByRole("alert")).toHaveTextContent("Could not copy.");
      expect(screen.getByRole("button", { name: "Copy" })).toBeInTheDocument();
    });

    it("restarts the 2 s window on a second click", async () => {
      stubClipboard(vi.fn().mockResolvedValue(undefined));
      await openAbout();
      const copy = await screen.findByRole("button", { name: "Copy" });
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      await act(async () => copy.click());
      act(() => void vi.advanceTimersByTime(1500));
      await act(async () => screen.getByRole("button", { name: "Copied" }).click());
      act(() => void vi.advanceTimersByTime(1999));
      expect(screen.getByRole("button", { name: "Copied" })).toBeInTheDocument();
      act(() => void vi.advanceTimersByTime(1));
      expect(screen.getByRole("button", { name: "Copy" })).toBeInTheDocument();
    });

    it("does not say Copied next to Could not copy.", async () => {
      const writeText = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("denied"));
      stubClipboard(writeText);
      await openAbout();
      const copy = await screen.findByRole("button", { name: "Copy" });
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      await act(async () => copy.click());
      expect(screen.getByRole("button", { name: "Copied" })).toBeInTheDocument();
      await act(async () => screen.getByRole("button", { name: "Copied" }).click());
      expect(screen.getByRole("alert")).toHaveTextContent("Could not copy.");
      expect(screen.queryByRole("button", { name: "Copied" })).toBeNull();
      expect(screen.getByRole("button", { name: "Copy" })).toBeInTheDocument();
      // The cleared timer must not fire later.
      expect(vi.getTimerCount()).toBe(0);
    });

    it("sets no state and arms no timer after unmount", async () => {
      let resolve!: () => void;
      stubClipboard(() => new Promise<void>((r) => (resolve = r)));
      const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
      try {
        const { unmount } = render(<SettingsWindow />);
        await userEvent.click(await screen.findByRole("button", { name: "About" }));
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        await act(async () => screen.getByRole("button", { name: "Copy" }).click());
        unmount();
        await act(async () => resolve());
        expect(vi.getTimerCount()).toBe(0);
        expect(errors).not.toHaveBeenCalled();
      } finally {
        errors.mockRestore();
      }
    });

    it("clears a running Copied timer on unmount", async () => {
      stubClipboard(vi.fn().mockResolvedValue(undefined));
      const { unmount } = render(<SettingsWindow />);
      await userEvent.click(await screen.findByRole("button", { name: "About" }));
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      await act(async () => screen.getByRole("button", { name: "Copy" }).click());
      const running = vi.getTimerCount();
      expect(running).toBeGreaterThan(0);
      unmount();
      expect(vi.getTimerCount()).toBe(0);
    });

    it("says Could not copy. when there is no clipboard (WebKitGTK)", async () => {
      Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
      await openAbout();
      await userEvent.click(await screen.findByRole("button", { name: "Copy" }));
      expect(await screen.findByRole("alert")).toHaveTextContent("Could not copy.");
    });

    it("opens each fixed link by its id, only when clicked", async () => {
      await openAbout();
      expect(commands.openExternalLink).not.toHaveBeenCalled();
      const cases: [string, string][] = [
        ["Source code on GitHub", "source"],
        ["Report a problem or suggest an idea", "issues"],
        ["More free open-source tools by Alex", "more_tools"],
        ["Third-party notices", "notices"],
        ["Licence text", "license"],
      ];
      for (const [name, id] of cases) {
        await userEvent.click(screen.getByRole("button", { name }));
        expect(commands.openExternalLink).toHaveBeenLastCalledWith(id);
      }
      expect(commands.openExternalLink).toHaveBeenCalledTimes(5);
    });

    it("still opens the data folder", async () => {
      await openAbout();
      expect(screen.getByText(settings.dataDir)).toBeInTheDocument();
      await userEvent.click(screen.getByRole("button", { name: "Open folder" }));
      expect(commands.openDataFolder).toHaveBeenCalledTimes(1);
    });

    it("shows a refused link as the page error", async () => {
      vi.mocked(commands.openExternalLink).mockRejectedValueOnce(new Error("Could not open the link."));
      await openAbout();
      await userEvent.click(screen.getByRole("button", { name: "Source code on GitHub" }));
      expect(await screen.findByRole("alert")).toHaveTextContent("Could not open the link.");
    });
  });

  describe("Appearance", () => {
    const defaults = settings.appAppearance;
    const openAppearance = async () => {
      render(<SettingsWindow />);
      await userEvent.click(await screen.findByRole("button", { name: "Appearance" }));
      return screen.findByRole("heading", { name: "Appearance" });
    };

    it("opens at ?section=appearance", async () => {
      window.history.replaceState(null, "", "/?section=appearance");
      try {
        render(<SettingsWindow />);
        expect(screen.getByRole("button", { name: "Appearance" })).toHaveAttribute("aria-current", "page");
        expect(await screen.findByRole("heading", { name: "Appearance" })).toBeInTheDocument();
        expect(screen.getByRole("switch", { name: "High-contrast notes" })).toHaveAttribute("aria-checked", "false");
      } finally {
        window.history.replaceState(null, "", "/");
      }
    });

    it("shows the saved values", async () => {
      vi.mocked(commands.getSettings).mockResolvedValue({
        ...settings,
        appAppearance: { highContrast: true, layout: "compact", defaultFont: "Fira Sans", defaultSize: 18 },
      });
      await openAppearance();
      expect(screen.getByRole("switch", { name: "High-contrast notes" })).toHaveAttribute("aria-checked", "true");
      expect(screen.getByRole("radio", { name: "Compact" })).toHaveAttribute("aria-checked", "true");
      expect(await screen.findByRole("combobox", { name: "Default font" })).toHaveValue("Fira Sans");
      expect(screen.getByText("18")).toBeInTheDocument();
    });

    it("turns high contrast on and saves the whole appearance", async () => {
      vi.mocked(commands.setAppAppearance).mockResolvedValue({ ...defaults, highContrast: true });
      await openAppearance();
      const sw = screen.getByRole("switch", { name: "High-contrast notes" });
      await userEvent.click(sw);
      expect(commands.setAppAppearance).toHaveBeenCalledWith({ ...defaults, highContrast: true });
      await waitFor(() => expect(sw).toHaveAttribute("aria-checked", "true"));
    });

    it("saves Compact as the layout", async () => {
      vi.mocked(commands.setAppAppearance).mockResolvedValue({ ...defaults, layout: "compact" });
      await openAppearance();
      await userEvent.click(screen.getByRole("radio", { name: "Compact" }));
      expect(commands.setAppAppearance).toHaveBeenCalledWith({ ...defaults, layout: "compact" });
      await waitFor(() => expect(screen.getByRole("radio", { name: "Compact" })).toHaveAttribute("aria-checked", "true"));
    });

    it("lists System default, then the installed fonts, and saves the one chosen", async () => {
      vi.mocked(commands.setAppAppearance).mockResolvedValue({ ...defaults, defaultFont: "Fira Sans" });
      await openAppearance();
      const select = await screen.findByRole("combobox", { name: "Default font" });
      await waitFor(() =>
        expect(within(select).getAllByRole("option").map((o) => o.textContent)).toEqual([
          "System default",
          "Atkinson Hyperlegible",
          "Fira Sans",
        ]),
      );
      await userEvent.selectOptions(select, "Fira Sans");
      expect(commands.setAppAppearance).toHaveBeenCalledWith({ ...defaults, defaultFont: "Fira Sans" });
      await waitFor(() => expect(select).toHaveValue("Fira Sans"));
    });

    it("saves System default as no font", async () => {
      vi.mocked(commands.getSettings).mockResolvedValue({ ...settings, appAppearance: { ...defaults, defaultFont: "Fira Sans" } });
      vi.mocked(commands.setAppAppearance).mockResolvedValue(defaults);
      await openAppearance();
      await userEvent.selectOptions(await screen.findByRole("combobox", { name: "Default font" }), "System default");
      expect(commands.setAppAppearance).toHaveBeenCalledWith({ ...defaults, defaultFont: null });
    });

    it("steps the size by one and stops at 10 and 32", async () => {
      vi.mocked(commands.getSettings).mockResolvedValue({ ...settings, appAppearance: { ...defaults, defaultSize: 10 } });
      vi.mocked(commands.setAppAppearance).mockImplementation(async (a) => a);
      await openAppearance();
      expect(screen.getByRole("button", { name: "Smaller default size" })).toBeDisabled();
      await userEvent.click(screen.getByRole("button", { name: "Larger default size" }));
      expect(commands.setAppAppearance).toHaveBeenLastCalledWith({ ...defaults, defaultSize: 11 });
      await waitFor(() => expect(screen.getByRole("button", { name: "Smaller default size" })).toBeEnabled());
    });

    it("disables the larger button at 32", async () => {
      vi.mocked(commands.getSettings).mockResolvedValue({ ...settings, appAppearance: { ...defaults, defaultSize: 32 } });
      await openAppearance();
      expect(screen.getByRole("button", { name: "Larger default size" })).toBeDisabled();
      expect(screen.getByRole("button", { name: "Smaller default size" })).toBeEnabled();
    });

    it("keeps every click when the size is stepped faster than it saves", async () => {
      const release: (() => void)[] = [];
      vi.mocked(commands.setAppAppearance).mockImplementation(
        (a) => new Promise((resolve) => release.push(() => resolve(a))),
      );
      await openAppearance();
      const bigger = screen.getByRole("button", { name: "Larger default size" });
      await userEvent.click(bigger);
      await userEvent.click(bigger);
      await userEvent.click(bigger);
      expect(screen.getByText("18")).toBeInTheDocument(); // shows what was asked for
      expect(commands.setAppAppearance).toHaveBeenCalledTimes(1); // one save at a time
      release[0]!();
      await waitFor(() => expect(commands.setAppAppearance).toHaveBeenCalledTimes(2));
      expect(commands.setAppAppearance).toHaveBeenLastCalledWith({ ...defaults, defaultSize: 18 });
      release[1]!();
      await waitFor(() => expect(screen.getByText("18")).toBeInTheDocument());
    });

    it("Reset appearance saves the defaults without asking", async () => {
      vi.mocked(commands.getSettings).mockResolvedValue({
        ...settings,
        appAppearance: { highContrast: true, layout: "compact", defaultFont: "Fira Sans", defaultSize: 20 },
      });
      vi.mocked(commands.setAppAppearance).mockResolvedValue(defaults);
      await openAppearance();
      await userEvent.click(screen.getByRole("button", { name: "Reset appearance" }));
      expect(commands.setAppAppearance).toHaveBeenCalledWith(defaults);
      expect(screen.queryByRole("dialog")).toBeNull();
      await waitFor(() => expect(screen.getByRole("switch", { name: "High-contrast notes" })).toHaveAttribute("aria-checked", "false"));
      expect(screen.getByRole("radio", { name: "Comfortable" })).toHaveAttribute("aria-checked", "true");
      expect(screen.getByText("15")).toBeInTheDocument();
    });

    it("shows the error and goes back to the saved value when a save fails", async () => {
      vi.mocked(commands.setAppAppearance).mockRejectedValue(new Error("The default size must be 10 to 32."));
      await openAppearance();
      const sw = screen.getByRole("switch", { name: "High-contrast notes" });
      await userEvent.click(sw);
      expect(await screen.findByRole("alert")).toHaveTextContent("The default size must be 10 to 32.");
      expect(sw).toHaveAttribute("aria-checked", "false");
    });

    it("clears the error after the next save works", async () => {
      vi.mocked(commands.setAppAppearance).mockRejectedValueOnce(new Error("no"));
      vi.mocked(commands.setAppAppearance).mockResolvedValueOnce({ ...defaults, layout: "compact" });
      await openAppearance();
      await userEvent.click(screen.getByRole("switch", { name: "High-contrast notes" }));
      await screen.findByRole("alert");
      await userEvent.click(screen.getByRole("radio", { name: "Compact" }));
      await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    });
  });

  describe("while a recovery code or a call that may issue one is up", () => {
    const CODE = "K7QD-M2XP-9WTR-4HNB-C6JF-V8LZ";
    const nav = () => screen.getByRole("navigation", { name: "Settings sections" });

    async function openNewCode() {
      render(<SettingsWindow />);
      await waitFor(() => expect(events.section).not.toBeNull());
      await userEvent.click(screen.getByRole("button", { name: "Privacy" }));
      await userEvent.click(await screen.findByRole("button", { name: "New recovery code…" }));
    }

    it("keeps Tab inside the dialog and gives focus back on close", async () => {
      await openNewCode();
      const dialog = screen.getByRole("dialog");
      expect(dialog).toHaveFocus();
      const cancel = within(dialog).getByRole("button", { name: "Cancel" });
      await userEvent.tab();
      expect(cancel).toHaveFocus();
      await userEvent.tab();
      expect(cancel).toHaveFocus();
      await userEvent.tab({ shift: true });
      expect(cancel).toHaveFocus();
      await userEvent.click(cancel);
      expect(screen.getByRole("button", { name: "New recovery code…" })).toHaveFocus();
    });

    it("Tab from the last control of the code view wraps inside it, and the nav is inert", async () => {
      await openNewCode();
      await userEvent.keyboard("246810");
      expect(await screen.findByText("Save your recovery code")).toBeInTheDocument();
      expect(nav()).toHaveAttribute("inert");
      for (const b of within(nav()).getAllByRole("button", { hidden: true })) expect(b).toBeDisabled();
      await userEvent.click(screen.getByRole("checkbox", { name: "I've written it down" }));
      const done = screen.getByRole("button", { name: "Done" });
      done.focus();
      await userEvent.tab();
      expect(screen.getByRole("button", { name: "Copy" })).toHaveFocus();
      await userEvent.tab({ shift: true });
      expect(done).toHaveFocus();
      for (let i = 0; i < 6; i++) {
        await userEvent.tab();
        expect(screen.getByRole("dialog")).toContainElement(document.activeElement as HTMLElement);
      }
      await userEvent.click(done);
      await waitFor(() => expect(nav()).not.toHaveAttribute("inert"));
      expect(screen.getByRole("button", { name: "General" })).toBeEnabled();
    });

    it("defers a section asked for while setRecoveryMethod is running", async () => {
      let answer!: (v: { check: { kind: "ok" }; recoveryCode: string | null }) => void;
      vi.mocked(commands.setRecoveryMethod).mockReturnValueOnce(new Promise((r) => (answer = r)));
      await openNewCode();
      await userEvent.keyboard("246810");
      await waitFor(() => expect(commands.setRecoveryMethod).toHaveBeenCalled());
      expect(nav()).toHaveAttribute("inert");
      act(() => events.section!("about"));
      expect(screen.getByRole("button", { name: "Privacy", hidden: true })).toHaveAttribute("aria-current", "page");
      expect(screen.getByRole("dialog")).toBeInTheDocument();
      await act(async () => answer({ check: { kind: "ok" }, recoveryCode: CODE }));
      // The code arrives and stays: the hold passes from the call to the code view.
      expect(await screen.findByText("Save your recovery code")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Privacy", hidden: true })).toHaveAttribute("aria-current", "page");
      await userEvent.click(screen.getByRole("checkbox", { name: "I've written it down" }));
      await userEvent.click(screen.getByRole("button", { name: "Done" }));
      await waitFor(() => expect(screen.getByRole("button", { name: "About" })).toHaveAttribute("aria-current", "page"));
    });
  });
});

