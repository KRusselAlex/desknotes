import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import fixture from "../../../tests/fixtures/rich-doc.json";
import type { NoteAction, NotesChanged, PrivacyChanged } from "../../ipc/events";
import type { Note, PrivacyStatus } from "../../types/note";

const handlers: {
  noteAction?: (a: NoteAction) => void;
  willQuit?: () => void;
  privacy?: (e: PrivacyChanged) => void;
  notesChanged?: (e: NotesChanged) => void;
} = {};
vi.mock("../../ipc/events", () => ({
  onNotesChanged: (h: (e: NotesChanged) => void) => {
    handlers.notesChanged = h;
    return Promise.resolve(() => undefined);
  },
  onPrivacyChanged: (h: (e: PrivacyChanged) => void) => {
    handlers.privacy = h;
    return Promise.resolve(() => undefined);
  },
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
    unlock: vi.fn(),
    privacyStatus: vi.fn(),
    setNotePrivate: vi.fn().mockResolvedValue(undefined),
    openSettings: vi.fn().mockResolvedValue(undefined),
    forgotPinSystem: vi.fn(),
    recoverWithCode: vi.fn(),
    duplicateNote: vi.fn().mockResolvedValue({}),
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
  private: false,
  privateLabel: "",
  locked: false,
  window: { x: 0, y: 0, width: 300, height: 280, visible: true, alwaysOnTop: false, collapsed: false },
  ...over,
});

/** What the native layer returns for a private note while the lock is on. */
const lockedNote = (over: Partial<Note> = {}): Note =>
  note({
    private: true,
    privateLabel: "Bank",
    locked: true,
    title: "Bank",
    content: { type: "doc", content: [{ type: "paragraph" }] },
    ...over,
  });

const status = (over: Partial<PrivacyStatus> = {}): PrivacyStatus => ({
  enabled: true,
  locked: false,
  lockAfterMinutes: 5,
  recovery: "system",
  recoveryMethod: "system",
  systemAvailable: true,
  resetAt: null,
  ...over,
});

const editorBox = () => screen.queryByRole("textbox", { name: "Note text" });

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

  it("gives the reason of a failed save on hover, for bug reports", async () => {
    vi.mocked(commands.saveNoteContent).mockRejectedValue(new Error("invalid data: link target must be _blank or empty"));
    const { container } = await openNote();
    await typeIntoNote(container, "x");
    await act(async () => window.dispatchEvent(new Event("blur")));

    expect(await screen.findByText(/Not saved/)).toHaveAttribute(
      "title",
      "Reason: invalid data: link target must be _blank or empty",
    );
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

  describe("private notes", () => {
    it("locked_note_never_mounts_the_editor", async () => {
      vi.mocked(commands.getNote).mockResolvedValue(lockedNote());
      const { container } = render(<NoteWindow noteId={ID} />);
      expect(await screen.findByText("Bank")).toBeInTheDocument();
      expect(editorBox()).toBeNull();
      expect(container.querySelector(".tiptap")).toBeNull();
      expect(screen.getByRole("img", { name: "0 of 6 digits" })).toBeInTheDocument();
      // Header keeps the colour and the hide control.
      expect(container.querySelector(".dn-note")).toHaveStyle({ "--note-hd": "#f6e77c" });
      expect(screen.getByRole("button", { name: "Hide note" })).toBeInTheDocument();
    });

    it("shows Private note when the note has no label, never its title", async () => {
      vi.mocked(commands.getNote).mockResolvedValue(lockedNote({ privateLabel: "", title: "Private note" }));
      const { container } = render(<NoteWindow noteId={ID} />);
      expect(await screen.findByText("Private note")).toBeInTheDocument();
      expect(container.textContent).not.toContain("Groceries");
    });

    it("six_digits_unlock_and_reload_the_note", async () => {
      vi.mocked(commands.getNote)
        .mockResolvedValueOnce(lockedNote())
        .mockResolvedValue(note({ private: true, privateLabel: "Bank" }));
      vi.mocked(commands.unlock).mockResolvedValue({ kind: "ok" });
      render(<NoteWindow noteId={ID} />);
      await screen.findByText("Bank");
      await userEvent.keyboard("482915");
      expect(commands.unlock).toHaveBeenCalledWith("482915");
      expect(await screen.findByRole("textbox", { name: "Note text" })).toBeInTheDocument();
      expect(screen.getByText("Groceries for Saturday")).toBeInTheDocument();
    });

    it("opens the editor when another window unlocks", async () => {
      vi.mocked(commands.getNote).mockResolvedValueOnce(lockedNote()).mockResolvedValue(note({ private: true }));
      render(<NoteWindow noteId={ID} />);
      await screen.findByText("Bank");
      await act(async () => handlers.privacy?.({ locked: false }));
      expect(await screen.findByRole("textbox", { name: "Note text" })).toBeInTheDocument();
    });

    it("lock_event_unmounts_editor_after_saving", async () => {
      const { container } = await openNote({ private: true, privateLabel: "Bank" });
      await typeIntoNote(container, "secret ");
      vi.mocked(commands.getNote).mockResolvedValue(lockedNote());
      await act(async () => handlers.privacy?.({ locked: true }));

      await waitFor(() => expect(editorBox()).toBeNull());
      expect(screen.getByText("Bank")).toBeInTheDocument();
      expect(container.textContent).not.toContain("secret");
      expect(container.textContent).not.toContain("Groceries");
      expect(commands.saveNoteContent).toHaveBeenCalledWith(ID, expect.stringContaining("secret"));
      const getNoteCalls = vi.mocked(commands.getNote).mock.invocationCallOrder;
      expect(vi.mocked(commands.saveNoteContent).mock.invocationCallOrder[0]!).toBeLessThan(getNoteCalls[getNoteCalls.length - 1]!);
    });

    it("locks when a refresh finds the note locked", async () => {
      await openNote({ private: true });
      vi.mocked(commands.getNote).mockResolvedValue(lockedNote());
      await act(async () => handlers.notesChanged?.({ id: null, kind: "other" }));
      await waitFor(() => expect(editorBox()).toBeNull());
      expect(screen.getByRole("img", { name: "0 of 6 digits" })).toBeInTheDocument();
    });

    it("keeps the editor and its text when the lock refused the last save", async () => {
      const { container } = await openNote({ private: true });
      vi.mocked(commands.saveNoteContent).mockRejectedValue(new Error("private notes are locked"));
      await typeIntoNote(container, "late words ");
      vi.mocked(commands.getNote).mockResolvedValue(lockedNote());
      await act(async () => handlers.privacy?.({ locked: true }));
      await act(async () => handlers.notesChanged?.({ id: null, kind: "other" }));

      expect(await screen.findByText(/Not saved/)).toHaveAttribute("title", "Reason: private notes are locked");
      expect(editorBox()).toHaveTextContent("late words");
      expect(screen.queryByRole("img", { name: /of 6 digits/ })).toBeNull();
    });

    it("leaves notes that are not private alone when the lock comes", async () => {
      const { container } = await openNote();
      vi.mocked(commands.getNote).mockClear();
      await act(async () => handlers.privacy?.({ locked: true }));
      expect(container.querySelector(".tiptap")).toHaveAttribute("contenteditable", "true");
      expect(commands.getNote).not.toHaveBeenCalled();
    });

    it("holds a private note read-only after answering save-all, until 5 s pass without a lock", async () => {
      const { container } = await openNote({ private: true });
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        await act(async () => handlers.willQuit?.());
        expect(commands.quitReady).toHaveBeenCalledWith(true);
        expect(container.querySelector(".tiptap")).toHaveAttribute("contenteditable", "false");
        await act(async () => vi.advanceTimersByTime(4_999));
        expect(container.querySelector(".tiptap")).toHaveAttribute("contenteditable", "false");
        await act(async () => vi.advanceTimersByTime(1));
        expect(container.querySelector(".tiptap")).toHaveAttribute("contenteditable", "true");
      } finally {
        vi.useRealTimers();
      }
    });

    it("shows the PIN when the lock follows a save-all answer", async () => {
      await openNote({ private: true });
      await act(async () => handlers.willQuit?.());
      vi.mocked(commands.getNote).mockResolvedValue(lockedNote());
      await act(async () => handlers.privacy?.({ locked: true }));
      await waitFor(() => expect(editorBox()).toBeNull());
      expect(screen.getByText("Bank")).toBeInTheDocument();
    });

    it("does not hold notes that are not private after save-all", async () => {
      const { container } = await openNote();
      await act(async () => handlers.willQuit?.());
      expect(commands.quitReady).toHaveBeenCalledWith(true);
      expect(container.querySelector(".tiptap")).toHaveAttribute("contenteditable", "true");
    });

    it("answers save-all at once while locked, and hides", async () => {
      vi.mocked(commands.getNote).mockResolvedValue(lockedNote());
      render(<NoteWindow noteId={ID} />);
      await screen.findByText("Bank");
      await act(async () => handlers.willQuit?.());
      expect(commands.quitReady).toHaveBeenCalledWith(true);
      await act(async () => handlers.noteAction?.("hide"));
      expect(commands.hideNote).toHaveBeenCalledWith(ID);
    });

    it("make_private_without_pin_opens_setup_first", async () => {
      vi.mocked(commands.privacyStatus).mockResolvedValue(status({ enabled: false }));
      await openNote();
      await userEvent.click(screen.getByRole("button", { name: "More" }));
      await userEvent.click(screen.getByRole("menuitem", { name: "Make private" }));
      await waitFor(() => expect(commands.openSettings).toHaveBeenCalledWith("privacy"));
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(commands.setNotePrivate).not.toHaveBeenCalled();
    });

    it("make_private_with_label", async () => {
      vi.mocked(commands.privacyStatus).mockResolvedValue(status());
      await openNote();
      await userEvent.click(screen.getByRole("button", { name: "More" }));
      await userEvent.click(screen.getByRole("menuitem", { name: "Make private" }));
      const dialog = await screen.findByRole("dialog", { name: "Make this note private" });
      const field = screen.getByRole("textbox", { name: "Label (optional)" });
      await waitFor(() => expect(field).toHaveFocus());
      expect(field).toHaveAttribute("maxLength", "40");
      await userEvent.type(field, "  Bank ");
      await userEvent.click(screen.getByRole("button", { name: "Make private" }));

      expect(commands.setNotePrivate).toHaveBeenCalledWith(ID, true, "Bank");
      await waitFor(() => expect(dialog).not.toBeInTheDocument());
      expect(commands.openSettings).not.toHaveBeenCalled();
      await userEvent.click(screen.getByRole("button", { name: "More" }));
      expect(screen.getByRole("menuitem", { name: "Make not private" })).toBeInTheDocument();
    });

    it("makes a note private without a label", async () => {
      vi.mocked(commands.privacyStatus).mockResolvedValue(status());
      await openNote();
      await userEvent.click(screen.getByRole("button", { name: "More" }));
      await userEvent.click(screen.getByRole("menuitem", { name: "Make private" }));
      await userEvent.click(await screen.findByRole("button", { name: "Make private" }));
      expect(commands.setNotePrivate).toHaveBeenCalledWith(ID, true, "");
    });

    it("keeps the dialog open with the reason when the label is refused", async () => {
      vi.mocked(commands.privacyStatus).mockResolvedValue(status());
      vi.mocked(commands.setNotePrivate).mockRejectedValueOnce(new Error("The label cannot contain control characters."));
      await openNote();
      await userEvent.click(screen.getByRole("button", { name: "More" }));
      await userEvent.click(screen.getByRole("menuitem", { name: "Make private" }));
      await userEvent.click(await screen.findByRole("button", { name: "Make private" }));
      expect(await screen.findByRole("alert")).toHaveTextContent("The label cannot contain control characters.");
      expect(screen.getByRole("dialog")).toBeInTheDocument();
      await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
      expect(screen.queryByRole("dialog")).toBeNull();
    });

    it("changes the label and makes a note not private, keeping its label", async () => {
      await openNote({ private: true, privateLabel: "Bank" });
      await userEvent.click(screen.getByRole("button", { name: "More" }));
      await userEvent.click(screen.getByRole("menuitem", { name: "Change private label…" }));
      const field = await screen.findByRole("textbox", { name: "Label (optional)" });
      expect(field).toHaveValue("Bank");
      await userEvent.clear(field);
      await userEvent.type(field, "Bills{Enter}");
      expect(commands.setNotePrivate).toHaveBeenLastCalledWith(ID, true, "Bills");
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

      await userEvent.click(screen.getByRole("button", { name: "More" }));
      await userEvent.click(screen.getByRole("menuitem", { name: "Make not private" }));
      expect(commands.setNotePrivate).toHaveBeenLastCalledWith(ID, false, "Bills");
      expect(commands.privacyStatus).not.toHaveBeenCalled();
    });

    it("never shows the title of a locked note, even when it differs from the label", async () => {
      vi.mocked(commands.getNote).mockResolvedValue(lockedNote({ title: "Account 0042, PIN 7731", privateLabel: "Bank" }));
      const { container } = render(<NoteWindow noteId={ID} />);
      expect(await screen.findByText("Bank")).toBeInTheDocument();
      expect(container.textContent).not.toContain("0042");
      expect(container.textContent).not.toContain("Account");
      expect(document.title).not.toContain("Account");
    });

    it("Forgot your PIN? proves it in this window, then opens Settings to choose a new PIN", async () => {
      vi.mocked(commands.getNote).mockResolvedValue(lockedNote());
      vi.mocked(commands.privacyStatus).mockResolvedValue(status({ locked: true, recovery: "system" }));
      vi.mocked(commands.forgotPinSystem).mockResolvedValue(true);
      render(<NoteWindow noteId={ID} />);
      await userEvent.click(await screen.findByRole("button", { name: "Forgot your PIN?" }));
      await waitFor(() => expect(commands.openSettings).toHaveBeenCalledWith("privacy-new-pin"));
      expect(commands.forgotPinSystem).toHaveBeenCalledTimes(1);
      expect(commands.unlock).not.toHaveBeenCalled();
    });

    it("digits typed while Forgot your PIN? is open never reach the note's PIN pad", async () => {
      vi.mocked(commands.getNote).mockResolvedValue(lockedNote());
      vi.mocked(commands.privacyStatus).mockResolvedValue(status({ locked: true, recovery: "system" }));
      vi.mocked(commands.forgotPinSystem).mockResolvedValue(false);
      render(<NoteWindow noteId={ID} />);
      await userEvent.click(await screen.findByRole("button", { name: "Forgot your PIN?" }));
      await screen.findByRole("dialog", { name: "Nothing was changed" });
      await userEvent.keyboard("111111");
      expect(commands.unlock).not.toHaveBeenCalled();
      expect(screen.getByRole("img", { name: "0 of 6 digits" })).toBeInTheDocument();

      // Back at the pad, typing works again.
      vi.mocked(commands.unlock).mockResolvedValue({ kind: "wrong", waitSecs: 0 });
      await userEvent.click(screen.getByRole("button", { name: "Back to PIN" }));
      await userEvent.keyboard("222222");
      expect(commands.unlock).toHaveBeenCalledTimes(1);
      expect(commands.unlock).toHaveBeenCalledWith("222222");
    });

    it("retyping a recovery code after a wrong one stays in the code field", async () => {
      vi.mocked(commands.getNote).mockResolvedValue(lockedNote());
      vi.mocked(commands.privacyStatus).mockResolvedValue(status({ locked: true, recovery: "code", recoveryMethod: "code" }));
      vi.mocked(commands.recoverWithCode).mockResolvedValue({ kind: "wrong", waitSecs: 0 });
      render(<NoteWindow noteId={ID} />);
      await userEvent.click(await screen.findByRole("button", { name: "Forgot your PIN?" }));
      const field = await screen.findByRole("textbox", { name: "Recovery code" });
      await userEvent.type(field, "AAAABBBBCCCCDDDDEEEEFFFF");
      await userEvent.click(screen.getByRole("button", { name: "Continue" }));
      expect(await screen.findByText("Wrong recovery code. Try again.")).toBeInTheDocument();
      await waitFor(() => expect(field).toHaveFocus());
      await userEvent.keyboard("{Backspace}{Backspace}{Backspace}{Backspace}{Backspace}{Backspace}234567");
      expect(commands.unlock).not.toHaveBeenCalled();
      expect(field).toHaveValue("AAAABBBBCCCCDDDDEE234567");
    });

    it("Forgot your PIN? with a recovery code shows the code entry in the note", async () => {
      vi.mocked(commands.getNote).mockResolvedValue(lockedNote());
      vi.mocked(commands.privacyStatus).mockResolvedValue(status({ locked: true, recovery: "code", recoveryMethod: "code" }));
      render(<NoteWindow noteId={ID} />);
      await userEvent.click(await screen.findByRole("button", { name: "Forgot your PIN?" }));
      expect(await screen.findByRole("dialog", { name: "Enter your recovery code" })).toBeInTheDocument();
      await userEvent.click(screen.getByRole("button", { name: "Back to PIN" }));
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(screen.getByRole("img", { name: "0 of 6 digits" })).toBeInTheDocument();
    });

    /** A private note whose last save the lock refused: editor and "Not saved" kept (R14). */
    async function refusedByTheLock() {
      const view = await openNote({ private: true, privateLabel: "Bank" });
      vi.mocked(commands.saveNoteContent).mockRejectedValueOnce(new Error("operation not allowed: private notes are locked"));
      await typeIntoNote(view.container, "late words ");
      vi.mocked(commands.getNote).mockResolvedValue(lockedNote());
      await act(async () => handlers.privacy?.({ locked: true }));
      await screen.findByText(/Not saved/);
      return view;
    }

    it("offers Unlock to save when the lock refused the save, and saves after the PIN (R20)", async () => {
      await refusedByTheLock();
      expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
      vi.mocked(commands.unlock).mockResolvedValue({ kind: "ok" });
      vi.mocked(commands.saveNoteContent).mockClear();
      await userEvent.click(screen.getByRole("button", { name: "Unlock to save" }));
      const dialog = await screen.findByRole("dialog", { name: "Unlock to save" });
      expect(dialog).toHaveTextContent("Enter your PIN to save it.");
      await userEvent.keyboard("246810");

      expect(commands.unlock).toHaveBeenCalledWith("246810");
      await waitFor(() => expect(commands.saveNoteContent).toHaveBeenCalledWith(ID, expect.stringContaining("late words")));
      await waitFor(() => expect(screen.queryByText(/Not saved/)).toBeNull());
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(editorBox()).toHaveTextContent("late words");
    });

    it("keeps Retry for saves refused for other reasons", async () => {
      const { container } = await openNote({ private: true });
      vi.mocked(commands.saveNoteContent).mockRejectedValueOnce(new Error("disk full"));
      await typeIntoNote(container, "x");
      await act(async () => handlers.willQuit?.());
      expect(await screen.findByRole("button", { name: "Retry" })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Unlock to save" })).toBeNull();
    });

    it("saves text the lock refused once private notes are unlocked in another window", async () => {
      await refusedByTheLock();
      vi.mocked(commands.saveNoteContent).mockClear();
      await act(async () => handlers.privacy?.({ locked: false }));
      await waitFor(() => expect(commands.saveNoteContent).toHaveBeenCalledWith(ID, expect.stringContaining("late words")));
      await waitFor(() => expect(screen.queryByText(/Not saved/)).toBeNull());
    });

    it("says why Make not private was refused (R21)", async () => {
      vi.mocked(commands.setNotePrivate).mockRejectedValueOnce(new Error("operation not allowed: private notes are locked"));
      await openNote({ private: true, privateLabel: "Bank" });
      await userEvent.click(screen.getByRole("button", { name: "More" }));
      await userEvent.click(screen.getByRole("menuitem", { name: "Make not private" }));
      expect(await screen.findByRole("alert")).toHaveTextContent("Unlock private notes first.");
      await userEvent.click(screen.getByRole("button", { name: "More" }));
      expect(screen.getByRole("menuitem", { name: "Make not private" })).toBeInTheDocument();
      await userEvent.keyboard("{Escape}");
      await userEvent.click(screen.getByRole("button", { name: "OK" }));
      expect(screen.queryByRole("alert")).toBeNull();
    });

    it("says why a label change was refused, in the dialog", async () => {
      vi.mocked(commands.setNotePrivate).mockRejectedValueOnce(new Error("operation not allowed: private notes are locked"));
      await openNote({ private: true, privateLabel: "Bank" });
      await userEvent.click(screen.getByRole("button", { name: "More" }));
      await userEvent.click(screen.getByRole("menuitem", { name: "Change private label…" }));
      await userEvent.type(await screen.findByRole("textbox", { name: "Label (optional)" }), "s{Enter}");
      expect(await screen.findByRole("alert")).toHaveTextContent("Unlock private notes first.");
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });

    it("says why Make private could not start", async () => {
      vi.mocked(commands.privacyStatus).mockRejectedValueOnce(new Error("database is locked"));
      await openNote();
      await userEvent.click(screen.getByRole("button", { name: "More" }));
      await userEvent.click(screen.getByRole("menuitem", { name: "Make private" }));
      expect(await screen.findByRole("alert")).toHaveTextContent("database is locked");
    });

    it("says why Duplicate was refused (D12)", async () => {
      vi.mocked(commands.duplicateNote).mockRejectedValueOnce(new Error("operation not allowed: private notes are locked"));
      await openNote({ private: true });
      await userEvent.click(screen.getByRole("button", { name: "More" }));
      await userEvent.click(screen.getByRole("menuitem", { name: "Duplicate" }));
      expect(await screen.findByRole("alert")).toHaveTextContent("Unlock private notes first.");
    });
  });
});
