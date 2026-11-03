import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("../../ipc/commands", () => ({
  commands: {
    getSettings: vi.fn(),
    getToggleShortcut: vi.fn().mockResolvedValue({ available: true, binding: null, label: null }),
    setLaunchAtLogin: vi.fn(),
    setNewNoteColor: vi.fn().mockResolvedValue(undefined),
    setMinNoteSize: vi.fn(),
    openDataFolder: vi.fn().mockResolvedValue(undefined),
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
  version: "0.1.0",
  dataDir: "/home/me/.local/share/io.github.krusselalex.desknotes",
  lastBackupAt: null,
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
    expect(screen.getByText(/version 0.1.0 · MIT license/)).toBeInTheDocument();
    expect(screen.getByText(settings.dataDir)).toBeInTheDocument();
    expect(screen.getByText("No data leaves this computer.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Open folder" }));
    expect(commands.openDataFolder).toHaveBeenCalled();
  });

  it("has Privacy between General and Backup", async () => {
    render(<SettingsWindow />);
    const nav = screen.getByRole("navigation", { name: "Settings sections" });
    expect([...nav.querySelectorAll("button")].map((b) => b.textContent)).toEqual([
      "General",
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

