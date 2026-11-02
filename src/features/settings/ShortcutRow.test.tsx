import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("../../ipc/commands", () => ({
  commands: {
    getToggleShortcut: vi.fn(),
    setToggleShortcut: vi.fn(),
    removeToggleShortcut: vi.fn(),
  },
}));

import { commands } from "../../ipc/commands";
import { ShortcutRow } from "./ShortcutRow";

const notSetUp = { available: true, binding: null, label: null };
const setUp = { available: true, binding: "<Control><Alt>n", label: "Ctrl+Alt+N" };

describe("ShortcutRow", () => {
  beforeEach(() => vi.clearAllMocks());

  it("sets up the suggested Ctrl+Alt+N only after the person confirms", async () => {
    vi.mocked(commands.getToggleShortcut).mockResolvedValue(notSetUp);
    vi.mocked(commands.setToggleShortcut).mockResolvedValue(setUp);
    render(<ShortcutRow />);
    expect(await screen.findByText("Not set up")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Set up…" }));
    const field = screen.getByRole("textbox", { name: "Shortcut" });
    expect(field).toHaveValue("Ctrl+Alt+N");
    expect(field).toHaveFocus();
    expect(commands.setToggleShortcut).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Set shortcut" }));
    expect(commands.setToggleShortcut).toHaveBeenCalledWith("<Control><Alt>n");
    expect(await screen.findByText("Ctrl+Alt+N")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Change" })).toBeInTheDocument();
  });

  it("records the keys pressed in the field", async () => {
    vi.mocked(commands.getToggleShortcut).mockResolvedValue(setUp);
    vi.mocked(commands.setToggleShortcut).mockResolvedValue({ ...setUp, binding: "<Super>k", label: "Super+K" });
    render(<ShortcutRow />);
    await userEvent.click(await screen.findByRole("button", { name: "Change" }));
    const field = screen.getByRole("textbox", { name: "Shortcut" });
    expect(screen.getByRole("button", { name: "Set shortcut" })).toBeDisabled(); // nothing changed yet
    fireEvent.keyDown(field, { key: "Meta", code: "MetaLeft", metaKey: true });
    expect(field).toHaveValue("Ctrl+Alt+N"); // modifiers alone change nothing
    fireEvent.keyDown(field, { key: "k", code: "KeyK", metaKey: true });
    expect(field).toHaveValue("Super+K");
    await userEvent.click(screen.getByRole("button", { name: "Set shortcut" }));
    expect(commands.setToggleShortcut).toHaveBeenCalledWith("<Super>k");
  });

  it("explains a combination without Ctrl, Alt or Super and keeps the previous one", async () => {
    vi.mocked(commands.getToggleShortcut).mockResolvedValue(notSetUp);
    render(<ShortcutRow />);
    await userEvent.click(await screen.findByRole("button", { name: "Set up…" }));
    const field = screen.getByRole("textbox", { name: "Shortcut" });
    fireEvent.keyDown(field, { key: "n", code: "KeyN" });
    expect(screen.getByRole("alert")).toHaveTextContent("Use Ctrl, Alt or Super with the key.");
    expect(field).toHaveValue("Ctrl+Alt+N");
    expect(field).toHaveAttribute("aria-invalid", "true");
  });

  it("shows a conflict reported by the native side and stays open", async () => {
    vi.mocked(commands.getToggleShortcut).mockResolvedValue(notSetUp);
    vi.mocked(commands.setToggleShortcut).mockRejectedValue(new Error("Ctrl+Alt+T is already used by terminal."));
    render(<ShortcutRow />);
    await userEvent.click(await screen.findByRole("button", { name: "Set up…" }));
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Shortcut" }), { key: "t", code: "KeyT", ctrlKey: true, altKey: true });
    await userEvent.click(screen.getByRole("button", { name: "Set shortcut" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("already used by terminal");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("removes the shortcut", async () => {
    vi.mocked(commands.getToggleShortcut).mockResolvedValue(setUp);
    vi.mocked(commands.removeToggleShortcut).mockResolvedValue(notSetUp);
    render(<ShortcutRow />);
    await userEvent.click(await screen.findByRole("button", { name: "Change" }));
    await userEvent.click(screen.getByRole("button", { name: "Remove shortcut" }));
    expect(commands.removeToggleShortcut).toHaveBeenCalled();
    expect(await screen.findByText("Not set up")).toBeInTheDocument();
  });

  it("closes with Escape without changing anything", async () => {
    vi.mocked(commands.getToggleShortcut).mockResolvedValue(notSetUp);
    render(<ShortcutRow />);
    await userEvent.click(await screen.findByRole("button", { name: "Set up…" }));
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(commands.setToggleShortcut).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Remove shortcut" })).not.toBeInTheDocument();
  });

  it("lets Tab and Shift+Tab move focus, keeps it in the dialog and gives it back on close", async () => {
    vi.mocked(commands.getToggleShortcut).mockResolvedValue(setUp);
    render(<ShortcutRow />);
    const change = await screen.findByRole("button", { name: "Change" });
    await userEvent.click(change);
    const field = screen.getByRole("textbox", { name: "Shortcut" });
    await userEvent.tab({ shift: true }); // backwards out of the field: wraps to the last button
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus(); // "Set shortcut" is disabled
    await userEvent.tab(); // forwards from the last one: back to the field
    expect(field).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    expect(change).toHaveFocus();
  });

  it("says so on desktops without GNOME shortcuts", async () => {
    vi.mocked(commands.getToggleShortcut).mockResolvedValue({ available: false, binding: null, label: null });
    render(<ShortcutRow />);
    expect(await screen.findByText("Not available on this desktop")).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});
