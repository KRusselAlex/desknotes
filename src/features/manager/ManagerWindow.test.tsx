import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { NoteSummary } from "../../types/note";

vi.mock("../../ipc/events", () => ({ onNotesChanged: () => Promise.resolve(() => undefined) }));
vi.mock("../../ipc/commands", () => ({
  commands: {
    listNotes: vi.fn(),
    noteCounts: vi.fn(),
    startupErrors: vi.fn(),
    createNote: vi.fn().mockResolvedValue({}),
    showNote: vi.fn().mockResolvedValue(undefined),
    hideNote: vi.fn().mockResolvedValue(undefined),
    setArchived: vi.fn().mockResolvedValue(undefined),
    restoreNote: vi.fn().mockResolvedValue(undefined),
    purgeNote: vi.fn().mockResolvedValue(undefined),
    trashNote: vi.fn().mockResolvedValue(undefined),
    quitApp: vi.fn(),
  },
}));

import { commands } from "../../ipc/commands";
import { ManagerWindow, highlight } from "./ManagerWindow";

const note = (over: Partial<NoteSummary> = {}): NoteSummary => ({
  id: "n1",
  title: "Weekend errands",
  color: "#fff4a3",
  updatedAt: Date.now(),
  archivedAt: null,
  deletedAt: null,
  visible: true,
  snippet: null,
  ...over,
});

describe("ManagerWindow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(commands.noteCounts).mockResolvedValue({ active: 1, archived: 0, trash: 1 });
    vi.mocked(commands.startupErrors).mockResolvedValue([]);
  });

  it("lists active notes with counts and shows a note when its row is clicked", async () => {
    vi.mocked(commands.listNotes).mockResolvedValue([note()]);
    render(<ManagerWindow />);
    const row = await screen.findByRole("listitem");
    expect(within(row).getByText("Weekend errands")).toBeInTheDocument();
    expect(within(row).getByText(/On desktop/)).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /Active/ })).toHaveTextContent("1");
    await userEvent.click(row);
    expect(commands.showNote).toHaveBeenCalledWith("n1");
  });

  it("searches and highlights the match in the snippet", async () => {
    vi.mocked(commands.listNotes).mockResolvedValue([note({ snippet: "Pick up the bike before 5" })]);
    render(<ManagerWindow />);
    await userEvent.type(screen.getByRole("searchbox", { name: "Search notes" }), "bike");
    await waitFor(() => expect(commands.listNotes).toHaveBeenLastCalledWith("active", "bike"));
    expect(await screen.findByText("bike", { selector: "mark" })).toBeInTheDocument();
    expect(screen.getByText("1 note in Active")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Clear search" }));
    expect(screen.getByRole("searchbox")).toHaveValue("");
  });

  it("asks for confirmation before permanent deletion and focuses Cancel", async () => {
    vi.mocked(commands.listNotes).mockResolvedValue([note({ deletedAt: Date.now() })]);
    render(<ManagerWindow />);
    await userEvent.click(screen.getByRole("tab", { name: /Trash/ }));
    await userEvent.click(await screen.findByRole("button", { name: "Delete permanently" }));
    expect(commands.purgeNote).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();

    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(commands.purgeNote).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "Delete permanently" }));
    await userEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(commands.purgeNote).toHaveBeenCalledWith("n1");
  });

  it("shows an empty state per tab", async () => {
    vi.mocked(commands.listNotes).mockResolvedValue([]);
    render(<ManagerWindow />);
    expect(await screen.findByText("No notes yet. Press Ctrl+N to create one.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("tab", { name: /Archived/ }));
    expect(await screen.findByText("Nothing archived.")).toBeInTheDocument();
  });

  it("shows errors in a banner instead of failing silently", async () => {
    vi.mocked(commands.listNotes).mockRejectedValue(new Error("database is locked"));
    render(<ManagerWindow />);
    expect(await screen.findByRole("alert")).toHaveTextContent("database is locked");
  });

  it("groups long lists by date", async () => {
    const many = Array.from({ length: 14 }, (_, i) => note({ id: `n${i}`, title: `Note ${i}` }));
    vi.mocked(commands.listNotes).mockResolvedValue(many);
    render(<ManagerWindow />);
    expect(await screen.findByText("Today")).toBeInTheDocument();
  });
});

describe("highlight", () => {
  it("marks the first case-insensitive match", () => {
    const { container } = render(<p>{highlight("Ride the Bike home", "bike")}</p>);
    expect(container.querySelector("mark")).toHaveTextContent("Bike");
    expect(container).toHaveTextContent("Ride the Bike home");
  });
});
