import { act, createEvent, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import fixture from "../../../tests/fixtures/rich-doc.json";
// @ts-expect-error The project has no Node typings; vitest runs in Node and can read the stylesheet.
import { readFileSync } from "node:fs";
import type { NoteAction, NotesChanged, PrivacyChanged } from "../../ipc/events";
import { APP_APPEARANCE_DEFAULTS, type AppAppearance, type Note, type PrivacyStatus } from "../../types/note";
import type { RemindersChanged, ReminderView } from "../../types/reminder";
import { appearanceStyle } from "../appearance/appearance";

const handlers: {
  appAppearance?: (a: AppAppearance) => void;
  noteAction?: (a: NoteAction) => void;
  willQuit?: () => void;
  privacy?: (e: PrivacyChanged) => void;
  notesChanged?: (e: NotesChanged) => void;
  reminders?: (e: RemindersChanged) => void;
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
  onAppAppearanceChanged: (h: (a: AppAppearance) => void) => {
    handlers.appAppearance = h;
    return Promise.resolve(() => undefined);
  },
  onRemindersChanged: (h: (e: RemindersChanged) => void) => {
    handlers.reminders = h;
    return Promise.resolve(() => undefined);
  },
}));
vi.mock("../../ipc/window", () => ({
  onCloseRequested: () => Promise.resolve(() => undefined),
  openExternal: vi.fn(),
}));
vi.mock("../../ipc/commands", async (importOriginal) => ({
  CommandError: (await importOriginal<typeof import("../../ipc/commands")>()).CommandError,
  commands: {
    getNote: vi.fn(),
    saveNoteContent: vi.fn(),
    setNoteColor: vi.fn().mockResolvedValue(undefined),
    setEditLocked: vi.fn().mockResolvedValue(undefined),
    hideNote: vi.fn().mockResolvedValue(undefined),
    setArchived: vi.fn().mockResolvedValue(undefined),
    setNoteCompleted: vi.fn().mockResolvedValue(undefined),
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
    openNoteSettings: vi.fn().mockResolvedValue(undefined),
    reopenNote: vi.fn().mockResolvedValue(undefined),
    getAppAppearance: vi.fn(),
    listFonts: vi.fn().mockResolvedValue([]),
    getReminder: vi.fn().mockResolvedValue(null),
    setReminder: vi.fn(),
    removeReminder: vi.fn().mockResolvedValue(undefined),
    addImage: vi.fn(),
    pickImage: vi.fn(),
  },
}));

import { CommandError, commands } from "../../ipc/commands";
import { setImageUrlResolver } from "../../ipc/images";
import { NoteWindow } from "./NoteWindow";

// jsdom has no native scheme; any address will do.
setImageUrlResolver((id) => `desknotes-image://localhost/${id}`);

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
  completedAt: null,
  editLocked: false,
  private: false,
  privateLabel: "",
  locked: false,
  appearance: {},
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

/** Opens the ⋯ menu and its Private list (DES-38: the private actions are one level down). */
async function openPrivateMenu() {
  await userEvent.click(screen.getByRole("button", { name: "More" }));
  await userEvent.click(screen.getByRole("menuitem", { name: "Private" }));
}

/** Menu entries in order, by accessible name (the quick buttons show a shorter label). */
const menuOrder = () =>
  Array.from(screen.getByRole("menu").querySelectorAll('[role^="menuitem"]')).map(
    (i) => i.getAttribute("aria-label") ?? i.textContent ?? "",
  );

describe("NoteWindow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(commands.getAppAppearance).mockResolvedValue({ ...APP_APPEARANCE_DEFAULTS });
    vi.mocked(commands.getReminder).mockResolvedValue(null);
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

  // Saved before text style existed: no textAlign and none of the new marks.
  it("opening an old note does not save", async () => {
    vi.mocked(commands.getNote).mockResolvedValue(
      note({
        content: {
          type: "doc",
          content: [
            { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Groceries for Saturday" }] },
            { type: "paragraph", content: [{ type: "text", marks: [{ type: "bold" }], text: "old" }] },
          ],
        },
      }),
    );
    render(<NoteWindow noteId={ID} />);
    await screen.findByText("old");
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
    await userEvent.click(screen.getByRole("menuitemcheckbox", { name: "Lock editing" }));
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

  it("saves, then marks itself done when the manager asks it to", async () => {
    const { container } = await openNote();
    await typeIntoNote(container, "last words ");
    await act(async () => handlers.noteAction?.("complete"));
    await waitFor(() => expect(commands.setNoteCompleted).toHaveBeenCalledWith(ID, true));
    expect(vi.mocked(commands.saveNoteContent).mock.invocationCallOrder[0]!).toBeLessThan(
      vi.mocked(commands.setNoteCompleted).mock.invocationCallOrder[0]!,
    );
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

  describe("note menu (DES-38, option B)", () => {
    const quick = () => screen.getByRole("group", { name: "Quick actions" });

    it("has the quick row, then Set reminder…, Mark as done, Note settings…, Private, Open manager, Archive and Move to trash", async () => {
      await openNote();
      await userEvent.click(screen.getByRole("button", { name: "More" }));
      expect(Array.from(quick().querySelectorAll('[role^="menuitem"]')).map((b) => b.getAttribute("aria-label"))).toEqual([
        "New note",
        "Duplicate",
        "Always on top",
        "Lock editing",
      ]);
      expect(menuOrder()).toEqual([
        "New note",
        "Duplicate",
        "Always on top",
        "Lock editing",
        "Set reminder…",
        "Mark as done",
        "Note settings…",
        "Private",
        "Open manager",
        "Archive",
        "Move to trash",
      ]);
      expect(screen.getByRole("menuitem", { name: "New note" })).toHaveFocus();
      expect(screen.getByRole("menuitem", { name: "Move to trash" })).toHaveClass("is-danger");
    });

    it("New and Duplicate run their command and close the menu", async () => {
      await openNote();
      await userEvent.click(screen.getByRole("button", { name: "More" }));
      await userEvent.click(screen.getByRole("menuitem", { name: "New note" }));
      expect(commands.createNote).toHaveBeenCalledTimes(1);
      expect(screen.queryByRole("menu")).toBeNull();

      await userEvent.click(screen.getByRole("button", { name: "More" }));
      await userEvent.click(screen.getByRole("menuitem", { name: "Duplicate" }));
      await waitFor(() => expect(commands.duplicateNote).toHaveBeenCalledWith(ID));
      expect(screen.queryByRole("menu")).toBeNull();
    });

    it("Always on top flips in place and keeps the menu open", async () => {
      await openNote();
      await userEvent.click(screen.getByRole("button", { name: "More" }));
      const pin = screen.getByRole("menuitemcheckbox", { name: "Always on top" });
      expect(pin).toHaveAttribute("aria-checked", "false");
      await userEvent.click(pin);
      expect(commands.setAlwaysOnTop).toHaveBeenCalledWith(ID, true);
      expect(screen.getByRole("menu")).toBeInTheDocument();
      expect(pin).toHaveAttribute("aria-checked", "true");
      await userEvent.click(pin);
      expect(commands.setAlwaysOnTop).toHaveBeenLastCalledWith(ID, false);
      expect(pin).toHaveAttribute("aria-checked", "false");
    });

    it("Lock editing flips in place, keeps the menu open and keeps focus on it, both ways", async () => {
      const { container } = await openNote();
      await userEvent.click(screen.getByRole("button", { name: "More" }));
      const lock = screen.getByRole("menuitemcheckbox", { name: "Lock editing" });
      expect(lock).toHaveAttribute("aria-checked", "false");
      expect(lock).toHaveAttribute("title", "Lock editing");
      await userEvent.click(lock);
      expect(commands.setEditLocked).toHaveBeenCalledWith(ID, true);
      await waitFor(() => expect(lock).toHaveAttribute("aria-checked", "true"));
      // The tooltip does not contradict the name: the state is aria-checked and the shading.
      expect(lock).toHaveAttribute("title", "Lock editing");
      expect(lock).toHaveAccessibleName("Lock editing");
      expect(container.querySelector(".tiptap")).toHaveAttribute("contenteditable", "false");

      await userEvent.click(lock);
      expect(commands.setEditLocked).toHaveBeenLastCalledWith(ID, false);
      await waitFor(() => expect(lock).toHaveAttribute("aria-checked", "false"));
      expect(screen.getByRole("menu")).toBeInTheDocument();
      // Allowing editing from the menu does not pull focus into the editor under the open menu.
      await act(async () => {
        await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 30)));
      });
      expect(lock).toHaveFocus();
    });

    it("shows Lock editing on for a read-only note", async () => {
      await openNote({ editLocked: true });
      await userEvent.click(screen.getByRole("button", { name: "More" }));
      expect(screen.getByRole("menuitemcheckbox", { name: "Lock editing" })).toHaveAttribute("aria-checked", "true");
    });

    it("↓ from the row goes to Set reminder…, ↑ from it back to the row, ←/→ along the row", async () => {
      await openNote();
      await userEvent.click(screen.getByRole("button", { name: "More" }));
      await userEvent.keyboard("{ArrowRight}");
      expect(screen.getByRole("menuitem", { name: "Duplicate" })).toHaveFocus();
      await userEvent.keyboard("{ArrowLeft}{ArrowLeft}");
      expect(screen.getByRole("menuitemcheckbox", { name: "Lock editing" })).toHaveFocus();
      await userEvent.keyboard("{ArrowDown}");
      expect(screen.getByRole("menuitem", { name: "Set reminder…" })).toHaveFocus();
      await userEvent.keyboard("{ArrowUp}");
      expect(screen.getByRole("menuitemcheckbox", { name: "Lock editing" })).toHaveFocus();
    });

    it("Set reminder… picked by keyboard still leaves focus on the date", async () => {
      await openNote();
      await userEvent.click(screen.getByRole("button", { name: "More" }));
      await userEvent.keyboard("{ArrowDown}{Enter}");
      await act(async () => {
        await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 30)));
      });
      expect(screen.getByLabelText("Date")).toHaveFocus();
    });

    it("Private opens Make private in place for a note that is not private, and Escape comes back", async () => {
      await openNote();
      await userEvent.click(screen.getByRole("button", { name: "More" }));
      await userEvent.keyboard("{ArrowDown}{ArrowDown}{ArrowDown}{ArrowDown}");
      const parent = screen.getByRole("menuitem", { name: "Private" });
      expect(parent).toHaveFocus();
      expect(parent.querySelectorAll("svg")).toHaveLength(2); // no check: not private
      await userEvent.keyboard("{Enter}");
      expect(within(screen.getByRole("menu")).getAllByRole("menuitem").map((i) => i.textContent)).toEqual([
        "Private",
        "Make private",
      ]);
      expect(screen.getByRole("menuitem", { name: "Make private" })).toHaveFocus();
      await userEvent.keyboard("{Escape}");
      expect(screen.getByRole("menuitem", { name: "Private" })).toHaveFocus();
      expect(screen.getByRole("menu")).toBeInTheDocument();
      await userEvent.keyboard("{Escape}");
      expect(screen.queryByRole("menu")).toBeNull();
    });

    it("Private offers Change private label… and Make not private for a private note, opening with → and back with ←", async () => {
      await openNote({ private: true, privateLabel: "Bank" });
      await userEvent.click(screen.getByRole("button", { name: "More" }));
      const parent = screen.getByRole("menuitem", { name: "Private" });
      expect(parent.querySelectorAll("svg")).toHaveLength(3); // icon, check, chevron
      parent.focus();
      await userEvent.keyboard("{ArrowRight}");
      expect(within(screen.getByRole("menu")).getAllByRole("menuitem").map((i) => i.textContent)).toEqual([
        "Private",
        "Change private label…",
        "Make not private",
      ]);
      expect(screen.getByRole("menuitem", { name: "Change private label…" })).toHaveFocus();
      await userEvent.keyboard("{ArrowLeft}");
      expect(screen.getByRole("menuitem", { name: "Private" })).toHaveFocus();
    });
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
      vi.mocked(commands.saveNoteContent).mockRejectedValue(new CommandError("private_locked", "private notes are locked"));
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
      await openPrivateMenu();
      await userEvent.click(screen.getByRole("menuitem", { name: "Make private" }));
      await waitFor(() => expect(commands.openSettings).toHaveBeenCalledWith("privacy"));
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(commands.setNotePrivate).not.toHaveBeenCalled();
    });

    it("make_private_with_label", async () => {
      vi.mocked(commands.privacyStatus).mockResolvedValue(status());
      await openNote();
      await openPrivateMenu();
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
      await openPrivateMenu();
      expect(screen.getByRole("menuitem", { name: "Make not private" })).toBeInTheDocument();
    });

    it("makes a note private without a label", async () => {
      vi.mocked(commands.privacyStatus).mockResolvedValue(status());
      await openNote();
      await openPrivateMenu();
      await userEvent.click(screen.getByRole("menuitem", { name: "Make private" }));
      await userEvent.click(await screen.findByRole("button", { name: "Make private" }));
      expect(commands.setNotePrivate).toHaveBeenCalledWith(ID, true, "");
    });

    it("keeps the dialog open with the reason when the label is refused", async () => {
      vi.mocked(commands.privacyStatus).mockResolvedValue(status());
      vi.mocked(commands.setNotePrivate).mockRejectedValueOnce(new Error("The label cannot contain control characters."));
      await openNote();
      await openPrivateMenu();
      await userEvent.click(screen.getByRole("menuitem", { name: "Make private" }));
      await userEvent.click(await screen.findByRole("button", { name: "Make private" }));
      expect(await screen.findByRole("alert")).toHaveTextContent("The label cannot contain control characters.");
      expect(screen.getByRole("dialog")).toBeInTheDocument();
      await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
      expect(screen.queryByRole("dialog")).toBeNull();
    });

    it("changes the label and makes a note not private, keeping its label", async () => {
      await openNote({ private: true, privateLabel: "Bank" });
      await openPrivateMenu();
      await userEvent.click(screen.getByRole("menuitem", { name: "Change private label…" }));
      const field = await screen.findByRole("textbox", { name: "Label (optional)" });
      expect(field).toHaveValue("Bank");
      await userEvent.clear(field);
      await userEvent.type(field, "Bills{Enter}");
      expect(commands.setNotePrivate).toHaveBeenLastCalledWith(ID, true, "Bills");
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

      await openPrivateMenu();
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
      vi.mocked(commands.saveNoteContent).mockRejectedValueOnce(new CommandError("private_locked", "private notes are locked"));
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

    it("knows the lock by the error code, not by its words", async () => {
      const { container } = await openNote({ private: true });
      vi.mocked(commands.saveNoteContent).mockRejectedValueOnce(new Error("private notes are locked"));
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
      vi.mocked(commands.setNotePrivate).mockRejectedValueOnce(new CommandError("private_locked", "private notes are locked"));
      await openNote({ private: true, privateLabel: "Bank" });
      await openPrivateMenu();
      await userEvent.click(screen.getByRole("menuitem", { name: "Make not private" }));
      expect(await screen.findByRole("alert")).toHaveTextContent("Unlock private notes first.");
      await openPrivateMenu();
      expect(screen.getByRole("menuitem", { name: "Make not private" })).toBeInTheDocument();
      await userEvent.keyboard("{Escape}");
      await userEvent.click(screen.getByRole("button", { name: "OK" }));
      expect(screen.queryByRole("alert")).toBeNull();
    });

    it("says why a label change was refused, in the dialog", async () => {
      vi.mocked(commands.setNotePrivate).mockRejectedValueOnce(new CommandError("private_locked", "private notes are locked"));
      await openNote({ private: true, privateLabel: "Bank" });
      await openPrivateMenu();
      await userEvent.click(screen.getByRole("menuitem", { name: "Change private label…" }));
      await userEvent.type(await screen.findByRole("textbox", { name: "Label (optional)" }), "s{Enter}");
      expect(await screen.findByRole("alert")).toHaveTextContent("Unlock private notes first.");
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });

    it("says why Make private could not start", async () => {
      vi.mocked(commands.privacyStatus).mockRejectedValueOnce(new Error("database is locked"));
      await openNote();
      await openPrivateMenu();
      await userEvent.click(screen.getByRole("menuitem", { name: "Make private" }));
      expect(await screen.findByRole("alert")).toHaveTextContent("database is locked");
    });

    it("says why Duplicate was refused (D12)", async () => {
      vi.mocked(commands.duplicateNote).mockRejectedValueOnce(new CommandError("private_locked", "private notes are locked"));
      await openNote({ private: true });
      await userEvent.click(screen.getByRole("button", { name: "More" }));
      await userEvent.click(screen.getByRole("menuitem", { name: "Duplicate" }));
      expect(await screen.findByRole("alert")).toHaveTextContent("Unlock private notes first.");
    });
  });

  describe("reminders", () => {
    const view = (over: Partial<ReminderView> = {}): ReminderView => {
      const due = new Date();
      due.setHours(due.getHours() + 3);
      return { date: "2030-01-01", time: "14:00", repeat: "none", dueAt: due.getTime(), overdue: false, ...over };
    };
    const hhmm = (ms: number) => {
      const d = new Date(ms);
      return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    };
    // A fixed noon keeps "due in 3 hours" on the same day; after 21:00 it would show a weekday.
    // Only Date is faked, so findBy* waits still run on real timers.
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date(2026, 10, 5, 12, 0));
    });
    afterEach(() => {
      vi.useRealTimers();
      window.innerWidth = 1024;
    });

    it("offers Set reminder… first in the list, right after the quick row, with a bell, and opens the popover", async () => {
      const { container } = await openNote();
      await userEvent.click(screen.getByRole("button", { name: "More" }));
      const order = menuOrder();
      expect(order.indexOf("Set reminder…")).toBe(order.indexOf("Lock editing") + 1);
      expect(within(screen.getByRole("menuitem", { name: "Set reminder…" })).getByText("Set reminder…").previousElementSibling?.tagName).toBe("svg");
      await userEvent.click(screen.getByRole("menuitem", { name: "Set reminder…" }));
      expect(screen.getByRole("dialog", { name: "Reminder" })).toBeInTheDocument();
      expect(screen.queryByRole("menu")).toBeNull();
      expect(container.querySelector(".dn-reminder-chip")).toBeNull();
    });

    it("keeps focus in the dialog, on the date, when opened from the menu (the editor's deferred focus must not take it back)", async () => {
      await openNote();
      await userEvent.click(screen.getByRole("button", { name: "More" }));
      await userEvent.click(screen.getByRole("menuitem", { name: "Set reminder…" }));
      await act(async () => {
        await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 30)));
      });
      expect(screen.getByLabelText("Date")).toHaveFocus();
    });

    it("gives focus back to the note when the popover closes", async () => {
      await openNote();
      await userEvent.click(screen.getByRole("button", { name: "More" }));
      await userEvent.click(screen.getByRole("menuitem", { name: "Set reminder…" }));
      await userEvent.keyboard("{Escape}");
      await act(async () => {
        await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 30)));
      });
      expect(editorBox()).toHaveFocus();
    });

    it("saves from the popover and closes it", async () => {
      vi.mocked(commands.setReminder).mockResolvedValue(view());
      await openNote();
      await userEvent.click(screen.getByRole("button", { name: "More" }));
      await userEvent.click(screen.getByRole("menuitem", { name: "Set reminder…" }));
      await userEvent.click(screen.getByRole("button", { name: "Save" }));
      expect(commands.setReminder).toHaveBeenCalledWith(ID, expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/), expect.stringMatching(/^\d{2}:00$/), "none");
      await waitFor(() => expect(screen.queryByRole("dialog", { name: "Reminder" })).toBeNull());
    });

    it("shows no chip when the note has no reminder", async () => {
      const { container } = await openNote();
      expect(container.querySelector(".dn-reminder-chip")).toBeNull();
    });

    it("shows the chip with the time while the note has a reminder, even on a read-only note", async () => {
      const r = view();
      vi.mocked(commands.getReminder).mockResolvedValue(r);
      vi.mocked(commands.getNote).mockResolvedValue(note({ editLocked: true }));
      render(<NoteWindow noteId={ID} />);
      const chip = await screen.findByRole("button", { name: `Reminder ${hhmm(r.dueAt)}` });
      expect(chip).toHaveTextContent(hhmm(r.dueAt));
      expect(chip.textContent).not.toMatch(/overdue/i);
      expect(chip).not.toHaveClass("is-overdue");
    });

    it("draws an overdue reminder in the danger style", async () => {
      vi.mocked(commands.getReminder).mockResolvedValue(view({ dueAt: Date.now() - 60_000, overdue: true }));
      await openNote();
      const chip = await screen.findByRole("button", { name: /^Reminder overdue · \d\d:\d\d$/ });
      expect(chip).toHaveClass("is-overdue");
      expect(chip.textContent).toMatch(/^\d\d:\d\d$/); // the visible text is unchanged
    });

    it("opens the popover on the existing reminder when the chip is clicked, and again to close", async () => {
      vi.mocked(commands.getReminder).mockResolvedValue(view({ date: "2030-01-01", time: "14:00", repeat: "daily" }));
      await openNote();
      const chip = await screen.findByRole("button", { name: /^Reminder / });
      await userEvent.click(chip);
      expect(screen.getByLabelText("Date")).toHaveValue("2030-01-01");
      expect(screen.getByRole("radio", { name: "Daily" })).toHaveAttribute("aria-checked", "true");
      expect(screen.getByRole("button", { name: "Remove" })).toBeInTheDocument();
      await userEvent.click(chip);
      expect(screen.queryByRole("dialog", { name: "Reminder" })).toBeNull();
    });

    it("opens the popover with Set reminder… on the existing reminder, with Remove", async () => {
      vi.mocked(commands.getReminder).mockResolvedValue(view({ date: "2030-01-01", time: "14:00" }));
      await openNote();
      await screen.findByRole("button", { name: /^Reminder / });
      await userEvent.click(screen.getByRole("button", { name: "More" }));
      await userEvent.click(screen.getByRole("menuitem", { name: "Set reminder…" }));
      expect(screen.getByLabelText("Date")).toHaveValue("2030-01-01");
      await userEvent.click(screen.getByRole("button", { name: "Remove" }));
      expect(commands.removeReminder).toHaveBeenCalledWith(ID);
    });

    it("refreshes on reminders-changed for this note, and for several (null), not for another note", async () => {
      const { container } = await openNote();
      expect(container.querySelector(".dn-reminder-chip")).toBeNull();
      vi.mocked(commands.getReminder).mockResolvedValue(view());
      vi.mocked(commands.getReminder).mockClear();
      await act(async () => handlers.reminders!({ noteId: "someone-else" }));
      expect(commands.getReminder).not.toHaveBeenCalled();
      await act(async () => handlers.reminders!({ noteId: ID }));
      expect(await screen.findByRole("button", { name: /^Reminder / })).toBeInTheDocument();
      vi.mocked(commands.getReminder).mockResolvedValue(null);
      await act(async () => handlers.reminders!({ noteId: null }));
      await waitFor(() => expect(container.querySelector(".dn-reminder-chip")).toBeNull());
    });

    it("looks again every minute, so today and overdue stay right", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        vi.mocked(commands.getNote).mockResolvedValue(note());
        render(<NoteWindow noteId={ID} />);
        await screen.findByText("Groceries for Saturday");
        vi.mocked(commands.getReminder).mockClear();
        vi.mocked(commands.getReminder).mockResolvedValue(view({ dueAt: Date.now() - 1_000, overdue: true }));
        await act(async () => {
          await vi.advanceTimersByTimeAsync(60_000);
        });
        expect(commands.getReminder).toHaveBeenCalledWith(ID);
        expect(await screen.findByRole("button", { name: /^Reminder / })).toHaveClass("is-overdue");
      } finally {
        vi.useRealTimers();
      }
    });

    // jsdom does no layout, so the header's fit at 300 px with a reminder (checked in the
    // preview) is pinned by its stylesheet rules and the markup they rely on.
    it("never lets the header overflow the window: the date gives way first, then the chips", async () => {
      const css = readFileSync("src/styles/note.css", "utf8"); // vitest blanks imported CSS
      const block = (selector: string) => {
        const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        return [...css.matchAll(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`, "g"))].map((m) => m[1]!).join("\n");
      };
      // The note clips instead of scrolling, so a click on a clipped control cannot shift it.
      expect(block(".dn-note")).toMatch(/overflow:\s*clip;/);
      expect(block(".dn-note")).not.toMatch(/overflow:\s*hidden;/);
      // The controls keep their buttons' width (no min-width: 0), so they are never cut.
      expect(block(".dn-note-controls")).not.toMatch(/min-width:\s*0/);
      expect(block(".dn-grip")).toMatch(/flex:\s*none;/);
      // The date takes only the room left (no width of its own) and drops out whole when it
      // does not fit: it wraps below a zero-width first item and is clipped.
      const date = block(".dn-note-controls > .dn-note-date");
      expect(date).toMatch(/width:\s*0;/);
      expect(date).toMatch(/flex:\s*1000 0 0;/);
      expect(date).toMatch(/flex-wrap:\s*wrap;/);
      expect(date).toMatch(/overflow:\s*clip;/);
      expect(block(".dn-note-controls > .dn-note-date::before")).toMatch(/height:\s*var\(--dn-header-h\);/);
      // Next the Read-only chip drops its word, by fixed widths (a note is its own window, so
      // the viewport is the note): below 360 px when locked with a reminder (the longest label,
      // "24 Nov 2027", needs 347 px with the word), below 260 px (NARROW) for any locked note
      // (240 px needed). It never shrinks itself; icon-only it is a 24 px circle whose word
      // stays for screen readers. No measuring, so nothing can flip back and forth.
      expect(block(".dn-readonly-chip")).toMatch(/flex:\s*none;/);
      expect(css).not.toMatch(/is-icon-only/);
      const media = (max: number, scope: string) => {
        const at = css.indexOf(`@media (max-width: ${max}px) {\n  ${scope} .dn-readonly-chip`);
        expect(at, `@media (max-width: ${max}px)`).toBeGreaterThan(-1);
        return css.slice(at, css.indexOf("\n}\n", at));
      };
      for (const [max, scope] of [
        [359, ".dn-note.has-readonly-reminder"],
        [259, ".dn-note.is-readonly"],
      ] as const) {
        const rules = media(max, scope);
        const chip = new RegExp(`${scope.replace(/\./g, "\\.")} \\.dn-readonly-chip\\s*\\{([^}]*)\\}`).exec(rules)?.[1];
        expect(chip, `${max}: chip`).toMatch(/width:\s*24px;/);
        expect(chip, `${max}: chip`).toMatch(/padding:\s*0;/);
        const word = new RegExp(`${scope.replace(/\./g, "\\.")} \\.dn-readonly-chip \\.dn-chip-text\\s*\\{([^}]*)\\}`).exec(rules)?.[1];
        expect(word, `${max}: word`).toMatch(/clip-path:\s*inset\(50%\);/);
      }
      // Only as a last resort the reminder chip shrinks (ellipsis); nothing takes that back.
      expect(block(".dn-reminder-chip")).toMatch(/min-width:\s*0;/);
      expect(block(".dn-reminder-chip")).toMatch(/flex-shrink:\s*1;/);
      expect(block(".dn-reminder-chip")).not.toMatch(/flex(-shrink)?:\s*(none|0)/);
      expect(block(".dn-chip-text")).toMatch(/text-overflow:\s*ellipsis;/);

      const r = view();
      vi.mocked(commands.getReminder).mockResolvedValue(r);
      await openNote({ editLocked: true });
      const chip = await screen.findByRole("button", { name: /^Reminder / });
      expect(chip.querySelector(".dn-chip-text")).toHaveTextContent(hhmm(r.dueAt));
      expect(screen.getByRole("button", { name: /Read-only/ }).querySelector(".dn-chip-text")).toHaveTextContent("Read-only");
    });

    it("marks the note has-readonly-reminder only while it is locked and has a reminder", async () => {
      const root = (c: HTMLElement) => c.querySelector(".dn-note")!;
      vi.mocked(commands.getReminder).mockResolvedValue(view());
      const both = await openNote({ editLocked: true });
      await screen.findByRole("button", { name: /^Reminder / });
      expect(root(both.container)).toHaveClass("has-readonly-reminder");
      // The word stays in the DOM, so the chip's name and tooltip stay "Read-only".
      expect(screen.getByRole("button", { name: "Read-only" })).toHaveAttribute("title", "Read-only. Click to allow editing.");
      both.unmount();

      const reminderOnly = await openNote();
      await screen.findByRole("button", { name: /^Reminder / });
      expect(root(reminderOnly.container)).not.toHaveClass("has-readonly-reminder");
      reminderOnly.unmount();

      vi.mocked(commands.getReminder).mockResolvedValue(null);
      const lockedOnly = await openNote({ editLocked: true });
      await waitFor(() => expect(commands.getReminder).toHaveBeenCalled());
      expect(root(lockedOnly.container)).not.toHaveClass("has-readonly-reminder");
    });

    it("hides the chip at narrow widths, with the date", async () => {
      window.innerWidth = 240;
      vi.mocked(commands.getReminder).mockResolvedValue(view());
      const { container } = await openNote();
      await waitFor(() => expect(commands.getReminder).toHaveBeenCalled());
      expect(screen.queryByRole("button", { name: /^Reminder / })).toBeNull();
      expect(container.querySelector(".dn-note-date")).toBeNull();
    });

    it("has no chip and no menu on a locked private note", async () => {
      vi.mocked(commands.getReminder).mockResolvedValue(view());
      vi.mocked(commands.getNote).mockResolvedValue(lockedNote());
      render(<NoteWindow noteId={ID} />);
      await screen.findByText("Bank");
      expect(screen.queryByRole("button", { name: /^Reminder / })).toBeNull();
      expect(screen.queryByRole("button", { name: "More" })).toBeNull();
    });

    it("closes the reminder popover when another header popover opens", async () => {
      vi.mocked(commands.getReminder).mockResolvedValue(view());
      await openNote();
      await userEvent.click(await screen.findByRole("button", { name: /^Reminder / }));
      expect(screen.getByRole("dialog", { name: "Reminder" })).toBeInTheDocument();
      await userEvent.click(screen.getByRole("button", { name: "Colour" }));
      expect(screen.queryByRole("dialog", { name: "Reminder" })).toBeNull();
      expect(screen.getByRole("dialog", { name: "Note colour" })).toBeInTheDocument();
    });

    it("closes the popover on Escape", async () => {
      await openNote();
      await userEvent.click(screen.getByRole("button", { name: "More" }));
      await userEvent.click(screen.getByRole("menuitem", { name: "Set reminder…" }));
      await userEvent.keyboard("{Escape}");
      expect(screen.queryByRole("dialog", { name: "Reminder" })).toBeNull();
    });
  });

  describe("appearance", () => {
    it("offers Note settings… right after Mark as done (which follows Set reminder…) and opens it for this note", async () => {
      await openNote();
      await userEvent.click(screen.getByRole("button", { name: "More" }));
      const order = menuOrder();
      expect(order.indexOf("Note settings…")).toBe(order.indexOf("Mark as done") + 1);
      await userEvent.click(screen.getByRole("menuitem", { name: "Note settings…" }));
      expect(commands.openNoteSettings).toHaveBeenCalledWith(ID);
    });

    it("shows the note's own text styling and opacity", async () => {
      vi.mocked(commands.getNote).mockResolvedValue(
        note({ appearance: { fontSize: 22, textColor: "#1d4f91", lineSpacing: 120, opacity: 85, font: "Ubuntu Mono" } }),
      );
      const { container } = render(<NoteWindow noteId={ID} />);
      await screen.findByText("Groceries for Saturday");
      const root = container.querySelector(".dn-note") as HTMLElement;
      expect(root.style.getPropertyValue("--note-font-size")).toBe("22px");
      expect(root.style.getPropertyValue("--note-ink")).toBe("#1d4f91");
      expect(root.style.getPropertyValue("--note-leading")).toBe("1.2");
      expect(root.style.getPropertyValue("--note-bg")).toBe("rgba(255, 244, 163, 0.85)");
      expect(root.style.getPropertyValue("--note-font")).toBe('"Ubuntu Mono", var(--dn-font)');
      expect(document.documentElement).toHaveClass("dn-see-through");
    });

    it("paints each region's opacity once: no root fill behind the header or the format bar", async () => {
      const { container } = await openNote({ appearance: { opacity: 80 } });
      const root = container.querySelector(".dn-note") as HTMLElement;
      // note.css gives `.dn-note.is-see-through` a body-only background; the header and
      // the format bar paint --note-hd themselves, so nothing is composited twice.
      expect(root).toHaveClass("is-see-through");
      expect(root).not.toHaveClass("has-bar");
      expect(container.querySelector(".dn-note-header")).toBeInTheDocument();
      await act(async () => (container.querySelector(".tiptap") as HTMLElement).focus());
      await waitFor(() => expect(root).toHaveClass("has-bar"));
      expect(container.querySelector(".dn-format-bar")).toBeInTheDocument();
    });

    it("keeps the plain root background at 100 %", async () => {
      const { container } = await openNote({ appearance: { opacity: 100 } });
      expect(container.querySelector(".dn-note")).not.toHaveClass("is-see-through");
    });

    it("applies the single-paint root to the locked private view too", async () => {
      vi.mocked(commands.getNote).mockResolvedValue(lockedNote({ appearance: { opacity: 90 } }));
      const { container } = render(<NoteWindow noteId={ID} />);
      await screen.findByText("Bank");
      expect(container.querySelector(".dn-note")).toHaveClass("is-see-through");
    });

    it("is not see-through at 100 %", async () => {
      await openNote({ appearance: { opacity: 100 } });
      expect(document.documentElement).not.toHaveClass("dn-see-through");
    });

    it("restyles on notes-changed without reloading the editor or losing typed text", async () => {
      const { container } = await openNote();
      await typeIntoNote(container, "typed-before ");
      expect(container.querySelector(".tiptap")).toHaveTextContent("typed-before");
      vi.mocked(commands.getNote).mockResolvedValue(
        note({ appearance: { fontSize: 28, textColor: "#8c491a" } }),
      );
      await act(async () => handlers.notesChanged?.({ id: ID, kind: "other" }));
      const root = container.querySelector(".dn-note") as HTMLElement;
      await waitFor(() => expect(root.style.getPropertyValue("--note-font-size")).toBe("28px"));
      expect(root.style.getPropertyValue("--note-ink")).toBe("#8c491a");
      expect(container.querySelector(".tiptap")).toHaveTextContent("typed-before");
      expect(commands.saveNoteContent).not.toHaveBeenCalled();
    });

    it("passes the direction to the editor", async () => {
      const { container } = await openNote({ appearance: { direction: "rtl" } });
      expect(container.querySelector(".tiptap")).toHaveAttribute("dir", "rtl");
    });

    it("uses automatic direction by default and follows a change", async () => {
      const { container } = await openNote();
      expect(container.querySelector(".tiptap")).toHaveAttribute("dir", "auto");
      vi.mocked(commands.getNote).mockResolvedValue(note({ appearance: { direction: "ltr" } }));
      await act(async () => handlers.notesChanged?.({ id: ID, kind: "other" }));
      await waitFor(() => expect(container.querySelector(".tiptap")).toHaveAttribute("dir", "ltr"));
    });

    it("lets each block decide its own direction in automatic mode (not one direction for the note)", async () => {
      const { container } = await openNote();
      // The editor is dir="auto" ...
      expect(container.querySelector(".tiptap")).toHaveAttribute("dir", "auto");
      // ... and the stylesheet makes every block resolve its own base direction under it,
      // and only under it: a fixed LTR or RTL note is left alone.
      const noteCss = readFileSync("src/styles/note.css", "utf8"); // vitest blanks imported CSS
      const rule = /\.dn-note-body \.tiptap\[dir="auto"\] :is\(([^)]*)\)\s*\{([^}]*)\}/.exec(noteCss);
      expect(rule).not.toBeNull();
      const blocks = rule![1]!.split(",").map((b) => b.trim());
      expect(blocks).toEqual(expect.arrayContaining(["p", "h1", "h2", "h3", "li"]));
      expect(rule![2]).toMatch(/unicode-bidi:\s*plaintext/);
      expect(noteCss).not.toMatch(/\.tiptap\[dir="(ltr|rtl)"\][^{]*\{[^}]*unicode-bidi/);
    });

    it("does not leave a failed reopen unhandled", async () => {
      vi.mocked(commands.reopenNote).mockRejectedValueOnce(new Error("did not close in time"));
      await openNote();
      await act(async () => handlers.noteAction?.("reopen"));
      await waitFor(() => expect(commands.reopenNote).toHaveBeenCalledWith(ID));
      await act(async () => undefined); // an unhandled rejection would fail the run
    });

    it("saves first and reopens the window only after a successful save", async () => {
      const { container } = await openNote();
      await typeIntoNote(container, "keep me ");
      await act(async () => handlers.noteAction?.("reopen"));
      await waitFor(() => expect(commands.reopenNote).toHaveBeenCalledWith(ID));
      expect(commands.saveNoteContent).toHaveBeenCalled();
      expect(vi.mocked(commands.saveNoteContent).mock.invocationCallOrder[0]!).toBeLessThan(
        vi.mocked(commands.reopenNote).mock.invocationCallOrder[0]!,
      );
    });

    it("reopens a locked private note at once: it holds no text to save", async () => {
      vi.mocked(commands.getNote).mockResolvedValue(lockedNote({ appearance: { opacity: 90 } }));
      render(<NoteWindow noteId={ID} />);
      await screen.findByText("Bank");
      expect(document.documentElement).toHaveClass("dn-see-through");
      await act(async () => handlers.noteAction?.("reopen"));
      expect(commands.reopenNote).toHaveBeenCalledWith(ID);
    });

    it("does not reopen when the save fails, and keeps the text", async () => {
      vi.mocked(commands.saveNoteContent).mockRejectedValue(new Error("disk full"));
      const { container } = await openNote();
      await typeIntoNote(container, "precious ");
      await act(async () => handlers.noteAction?.("reopen"));
      expect(await screen.findByText(/Not saved/)).toBeInTheDocument();
      expect(commands.reopenNote).not.toHaveBeenCalled();
      expect(container.querySelector(".tiptap")).toHaveTextContent("precious");
    });
  });

  describe("app appearance", () => {
    const appLook = (over: Partial<AppAppearance> = {}): AppAppearance => ({ ...APP_APPEARANCE_DEFAULTS, ...over });
    const rootOf = (container: HTMLElement) => container.querySelector(".dn-note") as HTMLElement;
    const vars = (el: HTMLElement) =>
      Object.fromEntries(["--note-bg", "--note-hd", "--note-ink", "--note-font-size", "--note-font"].map((k) => [k, el.style.getPropertyValue(k)]));

    it("high contrast hides but never changes the note's own values", async () => {
      vi.mocked(commands.getAppAppearance).mockResolvedValue(appLook({ highContrast: true }));
      const own = { opacity: 80, textColor: "#1d4f91", fontSize: 20 };
      const { container } = await openNote({ color: "#ffd8b1", appearance: own });
      const root = rootOf(container);
      expect(root).toHaveClass("is-high-contrast");
      // The inline variables are still the note's own: only the stylesheet paints it white.
      const expected = appearanceStyle("#ffd8b1", own) as Record<string, string>;
      expect(vars(root)).toEqual({
        "--note-bg": expected["--note-bg"],
        "--note-hd": expected["--note-hd"],
        "--note-ink": "#1d4f91",
        "--note-font-size": "20px",
        "--note-font": "var(--dn-font)",
      });
      expect(root.style.getPropertyValue("--note-bg")).toBe("rgba(255, 216, 177, 0.8)");
      const before = vars(root);

      await act(async () => handlers.appAppearance?.(appLook({ highContrast: false })));
      expect(root).not.toHaveClass("is-high-contrast");
      expect(root).toHaveClass("is-see-through");
      expect(vars(root)).toEqual(before);
      expect(commands.saveNoteContent).not.toHaveBeenCalled();
      expect(commands.setNoteColor).not.toHaveBeenCalled();
    });

    it("note reads app appearance before it renders", async () => {
      let answer: (a: AppAppearance) => void = () => undefined;
      vi.mocked(commands.getAppAppearance).mockReturnValue(new Promise((r) => (answer = r)));
      vi.mocked(commands.getNote).mockResolvedValue(note());
      const { container } = render(<NoteWindow noteId={ID} />);
      await waitFor(() => expect(commands.getNote).toHaveBeenCalled());
      await act(async () => undefined);
      expect(screen.queryByText("Groceries for Saturday")).toBeNull();
      expect(editorBox()).toBeNull();
      expect(rootOf(container)).toHaveAttribute("aria-busy", "true");

      await act(async () => answer(appLook({ highContrast: true, layout: "compact" })));
      await screen.findByText("Groceries for Saturday");
      const root = rootOf(container);
      expect(root).toHaveClass("is-high-contrast", "is-compact");
      expect(root.style.getPropertyValue("--note-font-size")).toBe("13.5px");
    });

    it("opens with the defaults when the app appearance cannot be read", async () => {
      vi.mocked(commands.getAppAppearance).mockRejectedValue(new Error("database is locked"));
      const { container } = await openNote();
      expect(rootOf(container)).not.toHaveClass("is-high-contrast");
      expect(rootOf(container)).not.toHaveClass("is-compact");
      expect(rootOf(container).style.getPropertyValue("--note-font-size")).toBe("15px");
    });

    it("follows a change at once without reloading the editor", async () => {
      const { container } = await openNote();
      await typeIntoNote(container, "typed-before ");
      await act(async () => handlers.appAppearance?.(appLook({ layout: "compact", defaultSize: 20, defaultFont: "Ubuntu" })));
      const root = rootOf(container);
      expect(root).toHaveClass("is-compact");
      expect(root.style.getPropertyValue("--note-font-size")).toBe("18px");
      expect(root.style.getPropertyValue("--note-font")).toBe('"Ubuntu", var(--dn-font)');
      expect(container.querySelector(".tiptap")).toHaveTextContent("typed-before");
    });

    it("keeps the note's own font and size over the app defaults", async () => {
      vi.mocked(commands.getAppAppearance).mockResolvedValue(appLook({ defaultSize: 18, defaultFont: "DejaVu Sans", layout: "compact" }));
      const { container } = await openNote({ appearance: { fontSize: 20, font: "Amiri" } });
      expect(rootOf(container).style.getPropertyValue("--note-font-size")).toBe("20px");
      expect(rootOf(container).style.getPropertyValue("--note-font")).toBe('"Amiri", var(--dn-font)');
    });

    it("applies the app look to the collapsed strip, the private lock and the load error (R3)", async () => {
      const look = appLook({ highContrast: true, layout: "compact", defaultSize: 20 });
      vi.mocked(commands.getAppAppearance).mockResolvedValue(look);

      vi.mocked(commands.getNote).mockResolvedValue(note({ window: { ...note().window, collapsed: true } }));
      const strip = render(<NoteWindow noteId={ID} />);
      await screen.findByRole("button", { name: "Expand" });
      expect(rootOf(strip.container)).toHaveClass("is-collapsed", "is-high-contrast", "is-compact");
      expect(rootOf(strip.container).style.getPropertyValue("--note-font-size")).toBe("18px");
      strip.unmount();

      vi.mocked(commands.getNote).mockResolvedValue(lockedNote());
      const locked = render(<NoteWindow noteId={ID} />);
      await screen.findByText("Bank");
      expect(rootOf(locked.container)).toHaveClass("is-private-locked", "is-high-contrast", "is-compact");
      locked.unmount();

      vi.mocked(commands.getNote).mockRejectedValue(new Error("unreadable"));
      const failed = render(<NoteWindow noteId={ID} />);
      await screen.findByText("This note could not be opened.");
      expect(rootOf(failed.container)).toHaveClass("is-high-contrast", "is-compact");
    });

    it("popover and note settings use the effective size: Aa shows the app default on a paragraph", async () => {
      vi.mocked(commands.getAppAppearance).mockResolvedValue(appLook({ defaultSize: 18 }));
      const { container } = await openNote();
      const el = container.querySelector(".tiptap") as HTMLElement & {
        editor?: { commands: { setTextSelection: (p: number) => void } };
      };
      await act(async () => el.focus());
      await act(async () => el.editor!.commands.setTextSelection(26)); // inside "Bold", the first paragraph
      await userEvent.click(await screen.findByRole("button", { name: "Text style" }));
      const dialog = screen.getByRole("dialog", { name: "Text style" });
      const size = within(dialog).getByRole("group", { name: "Size" });
      expect(within(size).getByText("18")).toBeInTheDocument();
    });

    it("keeps high contrast black on white whatever the system theme, with one focus ring", () => {
      const noteCss = readFileSync("src/styles/note.css", "utf8"); // vitest blanks imported CSS
      const tokens = readFileSync("src/styles/tokens.css", "utf8");
      const hc = /\.dn-note\.is-high-contrast\s*\{([^}]*)\}/.exec(noteCss)![1]!;
      const set = (name: string) => new RegExp(`${name}:\\s*([^;]+);`).exec(hc)?.[1]?.trim();
      // Every colour token the dark theme changes and a note uses resolves to the HC ink or ground.
      const dark = /\[data-theme="dark"\]\s*\{([^}]*)\}/.exec(tokens)![1]!;
      const darkColours = [...dark.matchAll(/(--dn-[a-z-]+):/g)].map((m) => m[1]!);
      const usedInNote = darkColours.filter((t) =>
        /^--dn-(danger|focus|accent-ink|app-(bg|surface|raised|text|muted|line|hover|press))/.test(t),
      );
      expect(usedInNote).toEqual(expect.arrayContaining(["--dn-danger", "--dn-danger-ink", "--dn-danger-bg", "--dn-focus"]));
      for (const token of usedInNote) expect(set(token), token).toBeDefined();
      for (const token of ["--dn-danger", "--dn-danger-hover", "--dn-danger-press", "--dn-danger-ink", "--dn-focus"]) {
        expect(set(token), token).toBe("var(--dn-hc-ink)");
      }
      expect(set("--dn-danger-bg")).toBe("var(--dn-hc-bg)");
      // The save error keeps standing out without its tint.
      expect(noteCss).toMatch(/\.dn-note\.is-high-contrast :is\(\.dn-save-error[^)]*\)\s*\{\s*border:\s*var\(--dn-hc-rule\) solid/);
      // Selected text is white on black.
      expect(noteCss).toMatch(
        /\.dn-note\.is-high-contrast ::selection\s*\{\s*background:\s*var\(--dn-hc-ink\);\s*color:\s*var\(--dn-hc-bg\);\s*\}/,
      );
      // No broad rule that puts an outline back on controls that draw their own ring.
      expect(noteCss).not.toMatch(/is-high-contrast[^{]*:is\(button/);
      expect(noteCss).not.toMatch(/is-high-contrast[^{]*\{[^}]*outline:\s*var\(--dn-hc-focus\)/);
    });

    it("draws the menu's quick toggles in high contrast: 3 px ring, inverted when on, both when focused and on (DES-38)", () => {
      const noteCss = readFileSync("src/styles/note.css", "utf8"); // vitest blanks imported CSS
      const rule = (selector: string) => {
        const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        return new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`).exec(noteCss)?.[1];
      };
      // Focused, off: the 3 px black ring on white, as menu items.
      const ring = /\.dn-note\.is-high-contrast :is\(([^)]*)\):focus-visible\s*\{\s*box-shadow:\s*inset 0 0 0 var\(--dn-hc-focus\) var\(--dn-hc-ink\);/.exec(noteCss);
      expect(ring?.[1]).toContain(".dn-menu-quick-btn");
      expect(ring?.[1]).toContain(".dn-menu-item");
      // On, unfocused: inverted, white on black.
      const on = rule('.dn-note.is-high-contrast .dn-menu-quick-btn[aria-checked="true"]');
      expect(on).toMatch(/background:\s*var\(--dn-hc-ink\);/);
      expect(on).toMatch(/color:\s*var\(--dn-hc-bg\);/);
      // The label follows the button's colour when on (components.css), so it turns white too.
      expect(readFileSync("src/styles/components.css", "utf8")).toMatch(
        /\.dn-menu-quick-btn\[aria-checked="true"\] \.dn-menu-quick-label\s*\{\s*color:\s*inherit;/,
      );
      // Focused and on: still inverted, with a white ring inside, so it differs from both.
      const both = rule('.dn-note.is-high-contrast .dn-menu-quick-btn[aria-checked="true"]:focus-visible');
      expect(both).toMatch(/box-shadow:\s*inset 0 0 0 var\(--dn-hc-focus\) var\(--dn-hc-ink\),\s*inset 0 0 0 calc\(var\(--dn-hc-focus\) \+ var\(--dn-hc-rule\)\) var\(--dn-hc-bg\);/);
      // It comes after the plain focus rule, which has a lower specificity anyway.
      expect(noteCss.indexOf('.dn-menu-quick-btn[aria-checked="true"]:focus-visible')).toBeGreaterThan(ring!.index);
    });

    it("keeps the quick row labels whole: columns at least their label wide, no ellipsis (DES-38)", () => {
      const css = readFileSync("src/styles/components.css", "utf8"); // vitest blanks imported CSS
      const row = /\.dn-menu-quick\s*\{([^}]*)\}/.exec(css)?.[1];
      expect(row).toMatch(/grid-template-columns:\s*repeat\(4, minmax\(min-content, 1fr\)\);/);
      const label = /\.dn-menu-quick-label\s*\{([^}]*)\}/.exec(css)?.[1];
      expect(label).toBeDefined();
      expect(label).not.toMatch(/text-overflow|overflow:/);
    });

    it("keeps the light danger tokens inside notes under a dark system theme (R14)", () => {
      const noteCss = readFileSync("src/styles/note.css", "utf8"); // vitest blanks imported CSS
      const tokens = readFileSync("src/styles/tokens.css", "utf8");
      const light = /:root\s*\{([^}]*)\}/.exec(tokens)![1]!;
      const dark = /\[data-theme="dark"\]\s*\{([^}]*)\}/.exec(tokens)![1]!;
      const value = (block: string, name: string) => new RegExp(`${name}:\\s*([^;]+);`).exec(block)?.[1]?.trim();
      // A rule on the note root itself (not the high-contrast one) re-declares them.
      const rootBlocks = [...noteCss.matchAll(/(?:^|\n)\.dn-note\s*\{([^}]*)\}/g)].map((m) => m[1]!);
      const scoped = rootBlocks.find((b) => b.includes("--dn-danger"));
      expect(scoped).toBeDefined();
      const darkDanger = [...dark.matchAll(/(--dn-danger[a-z-]*):/g)].map((m) => m[1]!);
      expect(darkDanger).toEqual(["--dn-danger", "--dn-danger-hover", "--dn-danger-press", "--dn-danger-bg", "--dn-danger-ink"]);
      for (const token of darkDanger) {
        expect(value(scoped!, token), token).toBe(value(light, token));
        expect(value(scoped!, token), token).not.toBe(value(dark, token));
      }
      // The overdue chip needs no dark-theme exception any more: white on the light red.
      expect(noteCss).not.toMatch(/\[data-theme="dark"\][^{]*\.dn-reminder-chip/);
      expect(noteCss).toMatch(/\.dn-reminder-chip\.is-overdue[^{]*\{\s*background:\s*var\(--dn-danger\);\s*color:\s*#fff;/);
      // High contrast still wins: it is more specific and sets every danger token itself.
      const hc = /\.dn-note\.is-high-contrast\s*\{([^}]*)\}/.exec(noteCss)![1]!;
      for (const token of darkDanger) expect(value(hc, token), token).toMatch(/^var\(--dn-hc-(ink|bg)\)$/);
    });

    it("styles high contrast and compact from the tokens, in the stylesheet", () => {
      const noteCss = readFileSync("src/styles/note.css", "utf8"); // vitest blanks imported CSS
      const tokens = readFileSync("src/styles/tokens.css", "utf8");
      for (const token of [
        "--dn-hc-bg: #ffffff",
        "--dn-hc-ink: #000000",
        "--dn-hc-rule: 2px",
        "--dn-hc-focus: 3px",
        "--dn-compact-text-scale: 0.9",
        "--dn-compact-pad: 10px",
        "--dn-compact-header: 28px",
      ]) {
        expect(tokens).toContain(token);
      }
      const hc = /\.dn-note\.is-high-contrast\s*\{([^}]*)\}/.exec(noteCss);
      expect(hc).not.toBeNull();
      expect(hc![1]).toMatch(/--note-bg:\s*var\(--dn-hc-bg\)/);
      expect(hc![1]).toMatch(/--note-hd:\s*var\(--dn-hc-bg\)/);
      expect(hc![1]).toMatch(/--note-ink:\s*var\(--dn-hc-ink\)/);
      // The rules are inset shadows, so a 28 px Compact header still fits its 28 px buttons.
      expect(noteCss).toMatch(
        /\.dn-note\.is-high-contrast \.dn-note-header\s*\{\s*box-shadow:\s*inset 0 calc\(-1 \* var\(--dn-hc-rule\)\) 0 var\(--dn-hc-line\);\s*\}/,
      );
      expect(noteCss).toMatch(
        /\.dn-note\.is-high-contrast \.dn-format-bar\s*\{\s*box-shadow:\s*inset 0 var\(--dn-hc-rule\) 0 var\(--dn-hc-line\);\s*\}/,
      );
      expect(noteCss).toMatch(/\.dn-note\.is-high-contrast :focus-visible\s*\{\s*outline-width:\s*var\(--dn-hc-focus\);\s*\}/);
      const compact = /\.dn-note\.is-compact:not\(\.is-collapsed\)\s*\{([^}]*)\}/.exec(noteCss);
      expect(compact![1]).toMatch(/--dn-header-h:\s*var\(--dn-compact-header\)/);
      expect(noteCss).toMatch(/\.dn-note\.is-compact \.dn-note-body\s*\{[^}]*var\(--dn-compact-pad\)/);
    });
  });
  // Completed notes (DES-39): Mark as done / Ctrl+D, and the 5-second Undo strip.
  describe("mark as done and the Undo strip", () => {
    const STRIP_MS = 5_000;
    const ctrl = (key: string, init: KeyboardEventInit = {}, target: Window | Element = window) =>
      act(() => {
        fireEvent.keyDown(target, { key, ctrlKey: true, bubbles: true, cancelable: true, ...init });
      });
    /** Fake timers only after the note has loaded, so React and the mocks keep running. */
    const fakeTimers = () => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const advance = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));
    afterEach(() => vi.useRealTimers());

    it("puts Mark as done (check icon) right after Set reminder… and starts the strip, closing the menu", async () => {
      await openNote();
      await userEvent.click(screen.getByRole("button", { name: "More" }));
      const order = menuOrder();
      expect(order.indexOf("Mark as done")).toBe(order.indexOf("Set reminder…") + 1);
      const item = screen.getByRole("menuitem", { name: "Mark as done" });
      expect(within(item).getByText("Mark as done").previousElementSibling?.tagName).toBe("svg");
      await userEvent.click(item);
      expect(screen.queryByRole("menu")).toBeNull();
      expect(screen.getByRole("status")).toHaveTextContent("Marked done");
      expect(screen.getByRole("button", { name: "Undo" })).toBeInTheDocument();
      expect(commands.setNoteCompleted).not.toHaveBeenCalled();
    });

    it("keeps focus on Undo when started from the menu (the editor's deferred focus must not take it back)", async () => {
      await openNote();
      await userEvent.click(screen.getByRole("button", { name: "More" }));
      await userEvent.click(screen.getByRole("menuitem", { name: "Mark as done" }));
      await act(async () => {
        await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 30)));
      });
      expect(screen.getByRole("button", { name: "Undo" })).toHaveFocus();
    });

    it("Ctrl+D opens the strip, from the editor and from elsewhere in the window", async () => {
      const { container } = await openNote();
      await ctrl("d", {}, container.querySelector(".tiptap")!);
      expect(screen.getByRole("status")).toHaveTextContent("Marked done");
      await userEvent.click(screen.getByRole("button", { name: "Undo" }));
      expect(screen.queryByRole("status")).toBeNull();
      await ctrl("d", {}, screen.getByRole("button", { name: "More" }));
      expect(screen.getByRole("status")).toBeInTheDocument();
    });

    it("Ctrl+D is taken from the editor: Tiptap never sees it", async () => {
      const { container } = await openNote();
      const seen = vi.fn();
      container.querySelector(".tiptap")!.addEventListener("keydown", seen);
      await ctrl("d", {}, container.querySelector(".tiptap")!);
      expect(seen).not.toHaveBeenCalled();
    });

    it("ignores Ctrl+Shift+D, Alt+Ctrl+D and a plain d", async () => {
      await openNote();
      await ctrl("d", { shiftKey: true });
      await ctrl("d", { altKey: true });
      await act(async () => void fireEvent.keyDown(window, { key: "d" }));
      expect(screen.queryByRole("status")).toBeNull();
    });

    it("Ctrl+D while the strip shows does nothing more (still one strip, one timer)", async () => {
      await openNote();
      fakeTimers();
      await ctrl("d");
      await advance(3_000);
      await ctrl("d");
      expect(screen.getAllByRole("status")).toHaveLength(1);
      await advance(2_100); // five seconds after the FIRST press
      expect(commands.setNoteCompleted).toHaveBeenCalledTimes(1);
    });

    it("works on a read-only (edit-locked) note", async () => {
      await openNote({ editLocked: true });
      await ctrl("d");
      expect(screen.getByRole("status")).toBeInTheDocument();
    });

    it("Undo cancels: nothing is saved or completed, and focus returns to the editor", async () => {
      await openNote();
      fakeTimers();
      await ctrl("d");
      await act(async () => void screen.getByRole("button", { name: "Undo" }).click());
      expect(screen.queryByRole("status")).toBeNull();
      await advance(STRIP_MS * 2);
      expect(commands.setNoteCompleted).not.toHaveBeenCalled();
      expect(commands.hideNote).not.toHaveBeenCalled();
      await act(async () => {
        await new Promise((r) => requestAnimationFrame(() => r(undefined)));
      });
      expect(editorBox()).toHaveFocus();
    });

    it("Ctrl+Z while the strip shows cancels it, and the editor does not also undo", async () => {
      const { container } = await openNote();
      await typeIntoNote(container, "kept ");
      fakeTimers();
      await ctrl("d");
      const seen = vi.fn();
      container.querySelector(".tiptap")!.addEventListener("keydown", seen);
      await ctrl("z", {}, container.querySelector(".tiptap")!);
      expect(screen.queryByRole("status")).toBeNull();
      expect(seen).not.toHaveBeenCalled();
      await advance(STRIP_MS * 2);
      expect(commands.setNoteCompleted).not.toHaveBeenCalled();
      expect(container.querySelector(".tiptap")).toHaveTextContent("kept");
    });

    it("Ctrl+Z without a strip is left to the editor", async () => {
      const { container } = await openNote();
      const seen = vi.fn();
      container.querySelector(".tiptap")!.addEventListener("keydown", seen);
      await ctrl("z", {}, container.querySelector(".tiptap")!);
      expect(seen).toHaveBeenCalled();
    });

    it("writes nothing during the five seconds, then marks done once they are over", async () => {
      await openNote();
      fakeTimers();
      await ctrl("d");
      await advance(STRIP_MS - 100);
      expect(commands.setNoteCompleted).not.toHaveBeenCalled();
      expect(commands.hideNote).not.toHaveBeenCalled();
      await advance(200);
      expect(commands.setNoteCompleted).toHaveBeenCalledExactlyOnceWith(ID, true);
    });

    // Review focus 4.
    it("strip_saves_then_completes: a pending edit is saved before the note is marked done", async () => {
      const { container } = await openNote();
      await typeIntoNote(container, "typed just before ");
      fakeTimers();
      await ctrl("d");
      // Typed text may autosave on its own; what waits for the end of the strip is the completion.
      await advance(STRIP_MS + 500);
      expect(commands.saveNoteContent).toHaveBeenCalled();
      expect(commands.setNoteCompleted).toHaveBeenCalledWith(ID, true);
      expect(vi.mocked(commands.saveNoteContent).mock.invocationCallOrder[0]!).toBeLessThan(
        vi.mocked(commands.setNoteCompleted).mock.invocationCallOrder[0]!,
      );
    });

    it("keeps the note open, with the error, when the save fails at the end of the strip", async () => {
      vi.mocked(commands.saveNoteContent).mockRejectedValue(new Error("disk full"));
      const { container } = await openNote();
      await typeIntoNote(container, "precious ");
      fakeTimers();
      await ctrl("d");
      await advance(STRIP_MS + 500);
      vi.useRealTimers();
      expect(commands.setNoteCompleted).not.toHaveBeenCalled();
      expect(await screen.findByText(/Not saved/)).toBeInTheDocument();
      expect(screen.queryByRole("status")).toBeNull();
    });

    it("closing the window during the strip marks the note done, after saving its text", async () => {
      const { container } = await openNote();
      await typeIntoNote(container, "last ");
      await ctrl("d");
      await userEvent.click(screen.getByRole("button", { name: "Hide note" }));
      await waitFor(() => expect(commands.setNoteCompleted).toHaveBeenCalledWith(ID, true));
      expect(commands.hideNote).not.toHaveBeenCalled();
      expect(vi.mocked(commands.saveNoteContent).mock.invocationCallOrder[0]!).toBeLessThan(
        vi.mocked(commands.setNoteCompleted).mock.invocationCallOrder[0]!,
      );
    });

    it("a hide asked by the manager during the strip marks the note done too", async () => {
      await openNote();
      await ctrl("d");
      await act(async () => handlers.noteAction?.("hide"));
      await waitFor(() => expect(commands.setNoteCompleted).toHaveBeenCalledWith(ID, true));
      expect(commands.hideNote).not.toHaveBeenCalled();
    });

    it("the timer does not fire a second time after the window was closed during the strip", async () => {
      await openNote();
      fakeTimers();
      await ctrl("d");
      await act(async () => handlers.noteAction?.("hide"));
      await advance(STRIP_MS * 2);
      expect(commands.setNoteCompleted).toHaveBeenCalledTimes(1);
    });

    it("quitting during the strip saves, marks the note done, then answers the handshake", async () => {
      const { container } = await openNote();
      await typeIntoNote(container, "before quit ");
      await ctrl("d");
      await act(async () => handlers.willQuit?.());
      await waitFor(() => expect(commands.quitReady).toHaveBeenCalledWith(true));
      expect(commands.setNoteCompleted).toHaveBeenCalledWith(ID, true);
      const order = (f: unknown) => (f as { mock: { invocationCallOrder: number[] } }).mock.invocationCallOrder[0]!;
      expect(order(commands.saveNoteContent)).toBeLessThan(order(commands.setNoteCompleted));
      expect(order(commands.setNoteCompleted)).toBeLessThan(order(commands.quitReady));
    });

    it("a round that arrives while the timer's completion is in flight is answered only after setNoteCompleted resolves", async () => {
      let finish: () => void = () => undefined;
      vi.mocked(commands.setNoteCompleted).mockReturnValue(new Promise<undefined>((r) => (finish = () => r(undefined))));
      await openNote();
      fakeTimers();
      await ctrl("d");
      await advance(STRIP_MS + 100);
      expect(commands.setNoteCompleted).toHaveBeenCalledTimes(1); // in flight, unresolved
      await act(async () => handlers.willQuit?.());
      await advance(50);
      expect(commands.quitReady).not.toHaveBeenCalled();
      await act(async () => finish());
      await advance(50);
      expect(commands.quitReady).toHaveBeenCalledExactlyOnceWith(true);
      expect(commands.setNoteCompleted).toHaveBeenCalledTimes(1);
    });

    it("a close asked while the timer's completion is in flight does not hide the note as well", async () => {
      let finish: () => void = () => undefined;
      vi.mocked(commands.setNoteCompleted).mockReturnValue(new Promise<undefined>((r) => (finish = () => r(undefined))));
      await openNote();
      fakeTimers();
      await ctrl("d");
      await advance(STRIP_MS + 100);
      await act(async () => handlers.noteAction?.("hide"));
      await act(async () => finish());
      await advance(50);
      expect(commands.hideNote).not.toHaveBeenCalled();
      expect(commands.setNoteCompleted).toHaveBeenCalledTimes(1);
    });

    it("Ctrl+D does nothing while a close is under way", async () => {
      vi.mocked(commands.hideNote).mockReturnValue(new Promise(() => undefined));
      await openNote();
      await userEvent.click(screen.getByRole("button", { name: "Hide note" }));
      await ctrl("d");
      expect(screen.queryByText("Marked done")).toBeNull();
    });

    it.each([
      ["the colour popover", "Colour"],
      ["the menu", "More"],
    ])("Ctrl+D does nothing while %s is open", async (_name, button) => {
      await openNote();
      await userEvent.click(screen.getByRole("button", { name: button }));
      await ctrl("d");
      expect(screen.queryByText("Marked done")).toBeNull();
    });

    it("Ctrl+D does nothing while the reminder dialog is open", async () => {
      await openNote();
      await userEvent.click(screen.getByRole("button", { name: "More" }));
      await userEvent.click(screen.getByRole("menuitem", { name: "Set reminder…" }));
      await ctrl("d");
      expect(screen.queryByText("Marked done")).toBeNull();
    });

    it("after a refused completion the strip is gone and focus is back in the editor", async () => {
      vi.mocked(commands.setNoteCompleted).mockRejectedValue(new Error("nope"));
      await openNote();
      fakeTimers();
      await ctrl("d");
      await advance(STRIP_MS + 100);
      vi.useRealTimers();
      await act(async () => {
        await new Promise((r) => requestAnimationFrame(() => r(undefined)));
      });
      expect(screen.queryByText("Marked done")).toBeNull();
      expect(editorBox()).toHaveFocus();
    });

    it("quitting without a strip does not mark anything done", async () => {
      await openNote();
      await act(async () => handlers.willQuit?.());
      await waitFor(() => expect(commands.quitReady).toHaveBeenCalledWith(true));
      expect(commands.setNoteCompleted).not.toHaveBeenCalled();
    });

    it("quitting during the strip with an unsaved edit does not mark it done and reports not saved", async () => {
      vi.mocked(commands.saveNoteContent).mockRejectedValue(new Error("disk full"));
      const { container } = await openNote();
      await typeIntoNote(container, "x");
      await ctrl("d");
      await act(async () => handlers.willQuit?.());
      await waitFor(() => expect(commands.quitReady).toHaveBeenCalledWith(false));
      expect(commands.setNoteCompleted).not.toHaveBeenCalled();
    });

    it("a locked private note has no menu and Ctrl+D does nothing", async () => {
      vi.mocked(commands.getNote).mockResolvedValue(lockedNote());
      render(<NoteWindow noteId={ID} />);
      await screen.findByText("Bank");
      await ctrl("d");
      expect(screen.queryByText("Marked done")).toBeNull();
    });

    it("Ctrl+D is ignored on a note whose content could not be loaded: no invisible strip, nothing marked done", async () => {
      vi.mocked(commands.getNote).mockResolvedValue(
        note({
          content: {
            type: "doc",
            content: [{ type: "paragraph", content: [{ type: "text", text: "secret", marks: [{ type: "unknownMark" }] }] }],
          },
        }),
      );
      render(<NoteWindow noteId={ID} />);
      await screen.findByText("This note could not be opened.");
      fakeTimers();
      await ctrl("d");
      await advance(STRIP_MS + 100);
      expect(commands.setNoteCompleted).not.toHaveBeenCalled();
    });

    it("collapsing during the strip marks the note done at once, after saving, like a close", async () => {
      const { container } = await openNote();
      await typeIntoNote(container, "last ");
      await ctrl("d");
      await userEvent.click(screen.getByRole("button", { name: "Collapse note" }));
      await waitFor(() => expect(commands.setNoteCompleted).toHaveBeenCalledWith(ID, true));
      expect(commands.setCollapsed).not.toHaveBeenCalled();
      expect(screen.queryByRole("status")).toBeNull();
      expect(vi.mocked(commands.saveNoteContent).mock.invocationCallOrder[0]!).toBeLessThan(
        vi.mocked(commands.setNoteCompleted).mock.invocationCallOrder[0]!,
      );
      expect(commands.setNoteCompleted).toHaveBeenCalledTimes(1);
    });

    it("collapsing without a strip still just collapses", async () => {
      await openNote();
      await userEvent.click(screen.getByRole("button", { name: "Collapse note" }));
      expect(commands.setCollapsed).toHaveBeenCalledWith(ID, true);
      expect(commands.setNoteCompleted).not.toHaveBeenCalled();
    });

    it("draws the strip with tokens only, black on white in high contrast", () => {
      const css = (readFileSync("src/styles/note.css", "utf8") as string).replace(/\/\*[\s\S]*?\*\//g, "");
      const rule = /\.dn-done-strip\s*\{([^}]*)\}/.exec(css);
      expect(rule).not.toBeNull();
      expect(rule![1]).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(/i);
      expect(rule![1]).toMatch(/position:\s*absolute/);
      expect(css).toMatch(/\.dn-note\.is-high-contrast \.dn-done-strip[^{]*\{[^}]*var\(--dn-hc-line\)/);
    });
  });
  describe("images", () => {
    const IMG = "d".repeat(64);
    const png = () => new File([new Uint8Array([137, 80, 78, 71])], "shot.png", { type: "image/png" });
    const editorEl = (container: HTMLElement) => container.querySelector(".tiptap") as HTMLElement;
    const imageNodes = (container: HTMLElement) =>
      JSON.stringify(
        (editorEl(container) as HTMLElement & { editor: { getJSON: () => unknown } }).editor.getJSON(),
      ).split(`"id":"${IMG}"`).length - 1;
    /** A paste whose clipboard has both pixels and HTML, as a browser's "Copy Image" gives. */
    const pasteWith = (el: HTMLElement, files: File[], html = `<img src="https://example.com/a.png">`) =>
      fireEvent.paste(el, {
        clipboardData: {
          files,
          types: ["Files", "text/html"],
          getData: (type: string) => (type === "text/html" ? html : ""),
        },
      });

    it("opens the shared fixture with its image", async () => {
      const { container } = await openNote();
      expect(container.querySelector(`.dn-image img[src="desknotes-image://localhost/${"a".repeat(64)}"]`)).not.toBeNull();
    });

    it("pasting a PNG with HTML inserts one image node and calls addImage once", async () => {
      vi.mocked(commands.addImage).mockResolvedValue({ id: IMG, width: 800, height: 450 });
      const { container } = await openNote();
      pasteWith(editorEl(container), [png()]);
      await waitFor(() => expect(imageNodes(container)).toBe(1));
      expect(commands.addImage).toHaveBeenCalledTimes(1);
      expect(vi.mocked(commands.addImage).mock.calls[0]![0]).toBe(ID);
      // The pixels win: nothing from the HTML (no foreign image, no extra text).
      expect(container.querySelector('img[src^="https:"]')).toBeNull();
      await waitFor(() => expect(commands.saveNoteContent).toHaveBeenCalled());
      expect(vi.mocked(commands.saveNoteContent).mock.calls.at(-1)![1]).toContain(`"id":"${IMG}"`);
    });

    it("a refused paste shows the message strip, and nothing is added", async () => {
      const { container } = await openNote();
      pasteWith(editorEl(container), [new File(["<svg/>"], "a.svg", { type: "image/svg+xml" })]);
      expect(await screen.findByRole("alert")).toHaveTextContent("DeskNotes can add PNG, JPEG, GIF or WebP images.");
      expect(commands.addImage).not.toHaveBeenCalled();
      // A new problem replaces the old one.
      vi.mocked(commands.addImage).mockRejectedValue(new CommandError("image_too_large", "x"));
      pasteWith(editorEl(container), [png()]);
      await waitFor(() =>
        expect(screen.getByRole("alert")).toHaveTextContent("That image is too large. Images can be up to 5 MB."),
      );
      expect(screen.getAllByRole("alert")).toHaveLength(1);
      await userEvent.click(screen.getByRole("button", { name: "Dismiss" }));
      expect(screen.queryByRole("alert")).toBeNull();
    });

    it("html_with_text_and_bitmap_pastes_as_text", async () => {
      const { container } = await openNote();
      pasteWith(editorEl(container), [png()], "<p>Hello office</p><table><tr><td>1</td></tr></table>");
      await waitFor(() => expect(editorEl(container)).toHaveTextContent("Hello office"));
      expect(commands.addImage).not.toHaveBeenCalled();
      expect(container.querySelectorAll(".dn-image")).toHaveLength(1); // the fixture's own
    });

    it("an image lands where it was pasted; a word selected meanwhile survives", async () => {
      const para = (text: string) => ({ type: "paragraph", content: [{ type: "text", text }] });
      const { container } = await openNote({ content: { type: "doc", content: [para("Groceries for Saturday"), para("alpha beta")] } });
      const ed = (editorEl(container) as HTMLElement & { editor: import("@tiptap/core").Editor }).editor;
      let finish!: (i: { id: string; width: number; height: number }) => void;
      vi.mocked(commands.addImage).mockReturnValue(new Promise((r) => (finish = r)));
      // The cursor after "alpha" (the second line starts at 25).
      await act(async () => ed.commands.setTextSelection(30));
      pasteWith(editorEl(container), [png()]);
      await waitFor(() => expect(commands.addImage).toHaveBeenCalledTimes(1));
      // While it uploads: text typed at the top, then the word "beta" selected.
      await act(async () => {
        ed.commands.insertContentAt(1, "My ");
        ed.commands.setTextSelection({ from: 34, to: 38 });
      });
      expect(ed.state.doc.textBetween(34, 38)).toBe("beta");
      await act(async () => finish({ id: IMG, width: 800, height: 450 }));
      const blocks = (ed.getJSON().content ?? []).map((n) => (n.type === "image" ? `image:${n.attrs!.id}` : ed.schema.nodeFromJSON(n).textContent));
      expect(blocks).toEqual(["My Groceries for Saturday", "alpha", `image:${IMG}`, " beta"]);
    });

    it("a paste without image files is left to the editor", async () => {
      const { container } = await openNote();
      pasteWith(editorEl(container), [], "<p>plain words</p>");
      await waitFor(() => expect(editorEl(container)).toHaveTextContent("plain words"));
      expect(commands.addImage).not.toHaveBeenCalled();
    });

    it("does not add images to a read-only note", async () => {
      const { container } = await openNote({ editLocked: true });
      pasteWith(editorEl(container), [png()]);
      await new Promise((r) => setTimeout(r, 50));
      expect(commands.addImage).not.toHaveBeenCalled();
    });

    it("a file dropped anywhere in the window never opens in it", async () => {
      const { container } = await openNote({ editLocked: true });
      const files = { files: [png()], types: ["Files"] };
      const over = createEvent.dragOver(container.querySelector(".dn-note-header")!, { dataTransfer: files });
      fireEvent(container.querySelector(".dn-note-header")!, over);
      expect(over.defaultPrevented).toBe(true);
      const drop = createEvent.drop(container.querySelector(".dn-note-header")!, { dataTransfer: files });
      fireEvent(container.querySelector(".dn-note-header")!, drop);
      expect(drop.defaultPrevented).toBe(true);
      expect(commands.addImage).not.toHaveBeenCalled();
    });
  });
});
