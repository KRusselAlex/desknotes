import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import fixture from "../../../tests/fixtures/rich-doc.json";
import type { Note } from "../../types/note";

vi.mock("../../ipc/events", () => ({
  onNotesChanged: () => Promise.resolve(() => undefined),
  onAppWillQuit: () => Promise.resolve(() => undefined),
}));
vi.mock("../../ipc/window", () => ({
  onCloseRequested: () => Promise.resolve(() => undefined),
  openExternal: vi.fn(),
}));
vi.mock("../../ipc/commands", () => ({
  commands: {
    getNote: vi.fn(),
    saveNoteContent: vi.fn().mockResolvedValue({ title: "", updatedAt: Date.now() }),
    setNoteColor: vi.fn().mockResolvedValue(undefined),
    setEditLocked: vi.fn().mockResolvedValue(undefined),
    hideNote: vi.fn().mockResolvedValue(undefined),
    showManager: vi.fn().mockResolvedValue(undefined),
    createNote: vi.fn().mockResolvedValue({}),
  },
}));

import { commands } from "../../ipc/commands";
import { NoteWindow } from "./NoteWindow";

const note = (over: Partial<Note> = {}): Note => ({
  id: "2f1c8f0e-6a8b-4c51-9d4e-2b8f5f1a9c3d",
  title: "Groceries for Saturday",
  content: fixture,
  color: "#fff4a3",
  createdAt: Date.now(),
  updatedAt: Date.now(),
  archivedAt: null,
  deletedAt: null,
  editLocked: false,
  window: { x: 0, y: 0, width: 300, height: 280, visible: true, alwaysOnTop: false },
  ...over,
});

describe("NoteWindow", () => {
  beforeEach(() => vi.clearAllMocks());

  it("renders the saved rich text with the note colour", async () => {
    vi.mocked(commands.getNote).mockResolvedValue(note());
    const { container } = render(<NoteWindow noteId={note().id} />);
    expect(await screen.findByText("Groceries for Saturday")).toBeInTheDocument();
    expect(container.querySelector(".dn-note")).toHaveStyle({ "--note-hd": "#f6e77c" });
    expect(screen.getByText("Bold").tagName).toBe("STRONG");
  });

  it("changes colour from the picker and saves it natively", async () => {
    vi.mocked(commands.getNote).mockResolvedValue(note());
    render(<NoteWindow noteId={note().id} />);
    await screen.findByText("Groceries for Saturday");
    await userEvent.click(screen.getByRole("button", { name: "Colour" }));
    await userEvent.click(screen.getByRole("radio", { name: "Mint" }));
    expect(commands.setNoteColor).toHaveBeenCalledWith(note().id, "#c8f7c5");
  });

  it("shows the read-only chip for edit-locked notes and unlocks on click", async () => {
    vi.mocked(commands.getNote).mockResolvedValue(note({ editLocked: true }));
    const { container } = render(<NoteWindow noteId={note().id} />);
    const chip = await screen.findByRole("button", { name: /Read-only/ });
    expect(container.querySelector(".tiptap")).toHaveAttribute("contenteditable", "false");
    expect(screen.queryByRole("button", { name: "Colour" })).not.toBeInTheDocument();
    await userEvent.click(chip);
    expect(commands.setEditLocked).toHaveBeenCalledWith(note().id, false);
    expect(screen.queryByRole("button", { name: /Read-only/ })).not.toBeInTheDocument();
  });

  it("locks editing from the more menu", async () => {
    vi.mocked(commands.getNote).mockResolvedValue(note());
    render(<NoteWindow noteId={note().id} />);
    await screen.findByText("Groceries for Saturday");
    await userEvent.click(screen.getByRole("button", { name: "More" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Lock editing" }));
    expect(commands.setEditLocked).toHaveBeenCalledWith(note().id, true);
    expect(await screen.findByRole("button", { name: /Read-only/ })).toBeInTheDocument();
  });

  it("hides the note through the native command", async () => {
    vi.mocked(commands.getNote).mockResolvedValue(note());
    render(<NoteWindow noteId={note().id} />);
    await screen.findByText("Groceries for Saturday");
    await userEvent.click(screen.getByRole("button", { name: "Hide note" }));
    expect(commands.hideNote).toHaveBeenCalledWith(note().id);
  });

  it("shows a recoverable message when the note cannot be opened", async () => {
    vi.mocked(commands.getNote).mockRejectedValue(new Error("unreadable"));
    render(<NoteWindow noteId="x" />);
    expect(await screen.findByText("This note could not be opened.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Open manager" }));
    expect(commands.showManager).toHaveBeenCalled();
  });
});
