import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { NoteSummary } from "../../types/note";

vi.mock("../../ipc/events", () => ({ onNotesChanged: () => Promise.resolve(() => undefined) }));
vi.mock("../../ipc/commands", () => ({
  commands: {
    listNotes: vi.fn(),
    createNote: vi.fn().mockResolvedValue({}),
    restoreNote: vi.fn().mockResolvedValue(undefined),
    purgeNote: vi.fn().mockResolvedValue(undefined),
    trashNote: vi.fn().mockResolvedValue(undefined),
    quitApp: vi.fn(),
  },
}));

import { commands } from "../../ipc/commands";
import { ManagerWindow, formatEdited } from "./ManagerWindow";

const note = (over: Partial<NoteSummary> = {}): NoteSummary => ({
  id: "n1",
  title: "Call the bank",
  color: "#fff4a3",
  updatedAt: Date.now(),
  archivedAt: null,
  deletedAt: null,
  visible: true,
  ...over,
});

describe("ManagerWindow", () => {
  beforeEach(() => {
    vi.mocked(commands.listNotes).mockReset();
  });

  it("lists active notes and searches", async () => {
    vi.mocked(commands.listNotes).mockResolvedValue([note()]);
    render(<ManagerWindow />);
    expect(await screen.findByText("Call the bank")).toBeInTheDocument();
    await userEvent.type(screen.getByRole("searchbox", { name: "Search notes" }), "bank");
    await waitFor(() => expect(commands.listNotes).toHaveBeenLastCalledWith("active", "bank"));
  });

  it("asks for confirmation before permanent deletion", async () => {
    vi.mocked(commands.listNotes).mockResolvedValue([note({ deletedAt: 1 })]);
    render(<ManagerWindow />);
    await userEvent.click(screen.getByRole("tab", { name: "Trash" }));
    await userEvent.click(await screen.findByRole("button", { name: "Delete permanently" }));
    expect(commands.purgeNote).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(commands.purgeNote).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "Delete permanently" }));
    await userEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(commands.purgeNote).toHaveBeenCalledWith("n1");
  });

  it("shows errors instead of failing silently", async () => {
    vi.mocked(commands.listNotes).mockRejectedValue(new Error("database is locked"));
    render(<ManagerWindow />);
    expect(await screen.findByRole("alert")).toHaveTextContent("database is locked");
  });

  it("formats today as a time and older dates as a date", () => {
    const now = new Date(2026, 10, 1, 15, 0).getTime();
    expect(formatEdited(new Date(2026, 10, 1, 9, 5).getTime(), now)).toMatch(/09|9/);
    expect(formatEdited(new Date(2025, 0, 2).getTime(), now)).toMatch(/2025/);
  });
});
