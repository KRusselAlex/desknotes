import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("../../ipc/commands", () => ({
  commands: {
    getSettings: vi.fn(),
    setLaunchAtLogin: vi.fn(),
    setNewNoteColor: vi.fn().mockResolvedValue(undefined),
    openDataFolder: vi.fn().mockResolvedValue(undefined),
  },
}));

import { commands } from "../../ipc/commands";
import { SettingsWindow } from "./SettingsWindow";

const settings = {
  launchAtLogin: false,
  newNoteColor: "#fff4a3",
  version: "0.1.0",
  dataDir: "/home/me/.local/share/io.github.krusselalex.desknotes",
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

  it("shows version, data folder and the privacy statement in About", async () => {
    render(<SettingsWindow />);
    await userEvent.click(await screen.findByRole("button", { name: "About" }));
    expect(screen.getByText(/version 0.1.0 · MIT license/)).toBeInTheDocument();
    expect(screen.getByText(settings.dataDir)).toBeInTheDocument();
    expect(screen.getByText("No data leaves this computer.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Open folder" }));
    expect(commands.openDataFolder).toHaveBeenCalled();
  });
});
