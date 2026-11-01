import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import fixture from "../../../tests/fixtures/rich-doc.json";
import type { NoteAction } from "../../ipc/events";
import type { Note } from "../../types/note";

const handlers: { noteAction?: (a: NoteAction) => void; willQuit?: () => void } = {};
vi.mock("../../ipc/events", () => ({
  onNotesChanged: () => Promise.resolve(() => undefined),
  onSaveAllRequest: (h: () => void) => {
    handlers.willQuit = h;
    return Promise.resolve(() => undefined);
  },
  onNoteAction: (h: (a: NoteAction) => void) => {
    handlers.noteAction = h;
    return Promise.resolve(() => undefined);
  },
}));
vi.mock("../../ipc/window", () => ({
  onCloseRequested: () => Promise.resolve(() => undefined),
  openExternal: vi.fn(),
}));
vi.mock("../../ipc/commands", () => ({
  commands: {
    getNote: vi.fn(),
    saveNoteContent: vi.fn(),
    setNoteColor: vi.fn().mockResolvedValue(undefined),
    setEditLocked: vi.fn().mockResolvedValue(undefined),
    hideNote: vi.fn().mockResolvedValue(undefined),
    setArchived: vi.fn().mockResolvedValue(undefined),
    trashNote: vi.fn().mockResolvedValue(undefined),
    showManager: vi.fn().mockResolvedValue(undefined),
    createNote: vi.fn().mockResolvedValue({}),
    quitReady: vi.fn().mockResolvedValue(undefined),
    setAlwaysOnTop: vi.fn().mockResolvedValue(undefined),
    setCollapsed: vi.fn().mockResolvedValue(undefined),
  },
}));

import { commands } from "../../ipc/commands";
import { NoteWindow } from "./NoteWindow";

const ID = "2f1c8f0e-6a8b-4c51-9d4e-2b8f5f1a9c3d";
const note = (over: Partial<Note> = {}): Note => ({
  id: ID,
  title: "Groceries for Saturday",
  content: fixture,
  color: "#fff4a3",
  createdAt: Date.now(),
  updatedAt: Date.now(),
  archivedAt: null,
  deletedAt: null,
  editLocked: false,
  window: { x: 0, y: 0, width: 300, height: 280, visible: true, alwaysOnTop: false, collapsed: false },
  ...over,
});

async function openNote(over: Partial<Note> = {}) {
  vi.mocked(commands.getNote).mockResolvedValue(note(over));
  const view = render(<NoteWindow noteId={ID} />);
  await screen.findByText("Groceries for Saturday");
  return view;
}

/** Type into the editor; jsdom has no real input pipeline, so use ProseMirror's API. */
async function typeIntoNote(container: HTMLElement, text: string) {
  const el = container.querySelector(".tiptap") as HTMLElement & {
    editor?: { commands: { insertContent: (t: string) => void } };
  };
  await act(async () => el.editor!.commands.insertContent(text));
}

describe("NoteWindow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Like the core: the title is derived from the first line of the note.
    vi.mocked(commands.saveNoteContent).mockResolvedValue({ title: "Groceries for Saturday", updatedAt: Date.now() });
  });

  it("renders the saved rich text with the note colour", async () => {
    const { container } = await openNote();
    expect(container.querySelector(".dn-note")).toHaveStyle({ "--note-hd": "#f6e77c" });
    expect(screen.getByText("Bold").tagName).toBe("STRONG");
  });

  it("does not save a note just because it was opened", async () => {
    await openNote();
    await new Promise((r) => setTimeout(r, 700));
    expect(commands.saveNoteContent).not.toHaveBeenCalled();
  });

  it("changes colour from the picker and saves it natively", async () => {
    await openNote();
    await userEvent.click(screen.getByRole("button", { name: "Colour" }));
    await userEvent.click(screen.getByRole("radio", { name: "Mint" }));
    expect(commands.setNoteColor).toHaveBeenCalledWith(ID, "#c8f7c5");
  });

  it("shows the read-only chip for edit-locked notes and unlocks on click", async () => {
    vi.mocked(commands.getNote).mockResolvedValue(note({ editLocked: true }));
    const { container } = render(<NoteWindow noteId={ID} />);
    const chip = await screen.findByRole("button", { name: /Read-only/ });
    expect(container.querySelector(".tiptap")).toHaveAttribute("contenteditable", "false");
    await userEvent.click(chip);
    expect(commands.setEditLocked).toHaveBeenCalledWith(ID, false);
  });

  it("locks editing from the more menu", async () => {
    await openNote();
    await userEvent.click(screen.getByRole("button", { name: "More" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Lock editing" }));
    expect(commands.setEditLocked).toHaveBeenCalledWith(ID, true);
  });

  it("saves pending text before hiding", async () => {
    const { container } = await openNote();
    await typeIntoNote(container, "more ");
    await userEvent.click(screen.getByRole("button", { name: "Hide note" }));
    expect(commands.saveNoteContent).toHaveBeenCalled();
    expect(commands.hideNote).toHaveBeenCalledWith(ID);
    expect(vi.mocked(commands.saveNoteContent).mock.invocationCallOrder[0]!).toBeLessThan(
      vi.mocked(commands.hideNote).mock.invocationCallOrder[0]!,
    );
  });

  it("keeps the window and the text when the save fails, whatever asks to close it", async () => {
    vi.mocked(commands.saveNoteContent).mockRejectedValue(new Error("disk full"));
    const { container } = await openNote();
    await typeIntoNote(container, "precious ");

    await userEvent.click(screen.getByRole("button", { name: "Hide note" }));
    await userEvent.click(screen.getByRole("button", { name: "More" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Move to trash" }));
    await act(async () => handlers.noteAction?.("archive"));

    expect(await screen.findByText(/Not saved/)).toBeInTheDocument();
    expect(commands.hideNote).not.toHaveBeenCalled();
    expect(commands.trashNote).not.toHaveBeenCalled();
    expect(commands.setArchived).not.toHaveBeenCalled();

    // After the save works again, hide still works (the close guard was released).
    vi.mocked(commands.saveNoteContent).mockResolvedValue({ title: "", updatedAt: Date.now() });
    await userEvent.click(screen.getByRole("button", { name: "Hide note" }));
    expect(commands.hideNote).toHaveBeenCalledWith(ID);
  });

  it("performs manager-requested actions itself after saving", async () => {
    await openNote();
    await act(async () => handlers.noteAction?.("trash"));
    await waitFor(() => expect(commands.trashNote).toHaveBeenCalledWith(ID));
  });

  it("answers the quit handshake with whether its text is saved", async () => {
    vi.mocked(commands.saveNoteContent).mockRejectedValue(new Error("disk full"));
    const { container } = await openNote();
    await typeIntoNote(container, "x");
    await act(async () => handlers.willQuit?.());
    await waitFor(() => expect(commands.quitReady).toHaveBeenCalledWith(false));
  });

  it("never saves over a note whose stored content cannot be loaded", async () => {
    vi.mocked(commands.getNote).mockResolvedValue(
      note({
        content: {
          type: "doc",
          content: [{ type: "paragraph", content: [{ type: "text", text: "secret", marks: [{ type: "unknownMark" }] }] }],
        },
      }),
    );
    render(<NoteWindow noteId={ID} />);
    expect(await screen.findByText("This note could not be opened.")).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 700));
    expect(commands.saveNoteContent).not.toHaveBeenCalled();
  });

  it("pins a note on top and shows the pin while it is on", async () => {
    await openNote();
    await userEvent.click(screen.getByRole("button", { name: "Always on top" }));
    expect(commands.setAlwaysOnTop).toHaveBeenCalledWith(ID, true);
    const pin = screen.getByRole("button", { name: "Always on top is on" });
    await userEvent.click(pin);
    expect(commands.setAlwaysOnTop).toHaveBeenLastCalledWith(ID, false);
  });

  it("offers always on top in the more menu as a checkbox", async () => {
    await openNote({ window: { x: 0, y: 0, width: 300, height: 280, visible: true, alwaysOnTop: true, collapsed: false } });
    await userEvent.click(screen.getByRole("button", { name: "More" }));
    expect(screen.getByRole("menuitemcheckbox", { name: "Always on top" })).toHaveAttribute("aria-checked", "true");
  });

  it("collapses to a strip with the title, after saving, and expands again", async () => {
    const { container } = await openNote();
    await typeIntoNote(container, "more ");
    await userEvent.click(screen.getByRole("button", { name: "Collapse note" }));
    expect(commands.saveNoteContent).toHaveBeenCalled();
    expect(commands.setCollapsed).toHaveBeenCalledWith(ID, true);
    expect(vi.mocked(commands.saveNoteContent).mock.invocationCallOrder[0]!).toBeLessThan(
      vi.mocked(commands.setCollapsed).mock.invocationCallOrder[0]!,
    );
    expect(container.querySelector(".dn-collapsed-title")).toHaveTextContent("Groceries for Saturday");
    await userEvent.click(screen.getByRole("button", { name: "Expand" }));
    expect(commands.setCollapsed).toHaveBeenLastCalledWith(ID, false);
    expect(container.querySelector(".dn-note-header")).not.toBeNull();
  });

  it("opens a collapsed note as its strip", async () => {
    vi.mocked(commands.getNote).mockResolvedValue(
      note({ window: { x: 0, y: 0, width: 300, height: 280, visible: true, alwaysOnTop: false, collapsed: true } }),
    );
    render(<NoteWindow noteId={ID} />);
    expect(await screen.findByRole("button", { name: "Expand" })).toBeInTheDocument();
  });

  it("does not collapse while its text is not saved", async () => {
    vi.mocked(commands.saveNoteContent).mockRejectedValue(new Error("disk full"));
    const { container } = await openNote();
    await typeIntoNote(container, "precious ");
    await userEvent.click(screen.getByRole("button", { name: "Collapse note" }));
    expect(commands.setCollapsed).not.toHaveBeenCalled();
    expect(await screen.findByText(/Not saved/)).toBeInTheDocument();
  });

  it("shows a recoverable message when the note cannot be loaded", async () => {
    vi.mocked(commands.getNote).mockRejectedValue(new Error("unreadable"));
    render(<NoteWindow noteId="x" />);
    expect(await screen.findByText("This note could not be opened.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Open manager" }));
    expect(commands.showManager).toHaveBeenCalled();
  });
});
