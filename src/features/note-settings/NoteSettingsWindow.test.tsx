import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { NoteResized, NotesChanged } from "../../ipc/events";
import type { Note } from "../../types/note";

const handlers: {
  notesChanged?: (e: NotesChanged) => void;
  resized?: (e: NoteResized) => void;
  switchNote?: (id: string) => void;
} = {};
vi.mock("../../ipc/events", () => ({
  onNotesChanged: (h: (e: NotesChanged) => void) => {
    handlers.notesChanged = h;
    return Promise.resolve(() => undefined);
  },
  onNoteResized: (h: (e: NoteResized) => void) => {
    handlers.resized = h;
    return Promise.resolve(() => undefined);
  },
  onNoteSettingsNote: (h: (id: string) => void) => {
    handlers.switchNote = h;
    return Promise.resolve(() => undefined);
  },
}));
vi.mock("../../ipc/window", () => ({ closeCurrentWindow: vi.fn() }));
vi.mock("../../ipc/commands", () => ({
  commands: {
    getNote: vi.fn(),
    listFonts: vi.fn(),
    setNoteAppearance: vi.fn().mockResolvedValue(undefined),
    setNoteSize: vi.fn(),
    setNoteColor: vi.fn().mockResolvedValue(undefined),
    setEditLocked: vi.fn().mockResolvedValue(undefined),
    setAlwaysOnTop: vi.fn().mockResolvedValue(undefined),
  },
}));

import { commands } from "../../ipc/commands";
import { closeCurrentWindow } from "../../ipc/window";
import { NoteSettingsWindow } from "./NoteSettingsWindow";

const ID = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";

function note(over: Partial<Note> = {}): Note {
  return {
    id: ID,
    title: "Secret plan",
    content: { type: "doc", content: [] },
    color: "#fff4a3",
    createdAt: 0,
    updatedAt: 0,
    archivedAt: null,
    deletedAt: null,
    editLocked: false,
    private: false,
    privateLabel: "",
    locked: false,
    appearance: {},
    window: { x: 0, y: 0, width: 300, height: 280, visible: true, alwaysOnTop: true, collapsed: false },
    ...over,
  };
}

async function open(n: Note = note()) {
  vi.mocked(commands.getNote).mockResolvedValue(n);
  render(<NoteSettingsWindow noteId={n.id} />);
  await screen.findByRole("radiogroup", { name: "Background colour" });
}

describe("NoteSettingsWindow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(commands.listFonts).mockResolvedValue(["DejaVu Sans", "Ubuntu"]);
    vi.mocked(commands.setNoteSize).mockImplementation(async (_id, width, height) => ({ width, height }));
  });

  it("shows the four cards and the footer, and no note text", async () => {
    await open();
    for (const heading of ["Text", "Background", "Size", "Behaviour"]) {
      expect(screen.getByRole("heading", { name: heading })).toBeInTheDocument();
    }
    expect(screen.getByRole("button", { name: "Reset to defaults" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Note colour" })).toHaveStyle({ backgroundColor: "#fff4a3" });
    expect(screen.queryByText(/Secret plan/)).toBeNull();
    expect(document.title).not.toContain("Secret plan");
    expect(screen.getByRole("switch", { name: "Always on top" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("switch", { name: "Lock editing" })).toHaveAttribute("aria-checked", "false");
    expect(screen.getByText("145 %")).toBeInTheDocument();
    expect(screen.getByText("100 %")).toBeInTheDocument();
  });

  it("makes the text larger with + and stops at 32", async () => {
    await open();
    await userEvent.click(screen.getByRole("button", { name: "Larger text" }));
    expect(commands.setNoteAppearance).toHaveBeenCalledWith(ID, { fontSize: 16 });
    expect(screen.getByText("16")).toBeInTheDocument();
  });

  it("does not go above 32", async () => {
    await open(note({ appearance: { fontSize: 32 } }));
    const plus = screen.getByRole("button", { name: "Larger text" });
    expect(plus).toBeDisabled();
    await userEvent.click(plus);
    expect(commands.setNoteAppearance).not.toHaveBeenCalled();
  });

  it("chooses a text colour and keeps the other settings", async () => {
    await open(note({ appearance: { fontSize: 18 } }));
    await userEvent.click(screen.getByRole("radio", { name: "Blue text" }));
    expect(commands.setNoteAppearance).toHaveBeenCalledWith(ID, { fontSize: 18, textColor: "#1d4f91" });
  });

  it("warns when the text would be hard to read on a dark custom background", async () => {
    await open();
    expect(screen.queryByText("Text may be hard to read on this colour.")).toBeNull();
    fireEvent.change(screen.getByLabelText("Custom colour"), { target: { value: "#201e1d" } });
    expect(commands.setNoteColor).toHaveBeenCalledWith(ID, "#201e1d");
    expect(screen.getByText("Text may be hard to read on this colour.")).toBeInTheDocument();
  });

  it("chooses a preset background colour", async () => {
    await open();
    const mint = screen.getByRole("radio", { name: "Mint" });
    await userEvent.click(mint);
    expect(commands.setNoteColor).toHaveBeenCalledWith(ID, "#c8f7c5");
    expect(mint).toHaveAttribute("aria-checked", "true");
  });

  it("sends the line spacing at most every 100 ms while dragging, and on release", async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(commands.getNote).mockResolvedValue(note());
      render(<NoteSettingsWindow noteId={ID} />);
      await act(async () => {
        await vi.runOnlyPendingTimersAsync();
      });
      const slider = screen.getByRole("slider", { name: "Line spacing" });
      fireEvent.pointerDown(slider);
      fireEvent.change(slider, { target: { value: "150" } });
      fireEvent.change(slider, { target: { value: "155" } });
      fireEvent.change(slider, { target: { value: "160" } });
      expect(commands.setNoteAppearance).toHaveBeenCalledTimes(1);
      expect(commands.setNoteAppearance).toHaveBeenLastCalledWith(ID, { lineSpacing: 150 });
      expect(screen.getByText("160 %")).toBeInTheDocument();
      fireEvent.pointerUp(slider);
      expect(commands.setNoteAppearance).toHaveBeenCalledTimes(2);
      expect(commands.setNoteAppearance).toHaveBeenLastCalledWith(ID, { lineSpacing: 160 });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(500);
      });
      expect(commands.setNoteAppearance).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("sets the opacity", async () => {
    await open();
    const slider = screen.getByRole("slider", { name: "Opacity" });
    fireEvent.change(slider, { target: { value: "85" } });
    fireEvent.pointerUp(slider);
    expect(commands.setNoteAppearance).toHaveBeenLastCalledWith(ID, { opacity: 85 });
    expect(screen.getByText("85 %")).toBeInTheDocument();
  });

  it("sets the direction", async () => {
    await open();
    await userEvent.click(screen.getByRole("radio", { name: "RTL" }));
    expect(commands.setNoteAppearance).toHaveBeenCalledWith(ID, { direction: "rtl" });
  });

  it("chooses a font, and back to the system font", async () => {
    await open(note({ appearance: { fontSize: 20 } }));
    const font = screen.getByRole("combobox", { name: "Font" });
    await waitFor(() => expect(within(font).getByRole("option", { name: "Ubuntu" })).toBeInTheDocument());
    await userEvent.selectOptions(font, "Ubuntu");
    expect(commands.setNoteAppearance).toHaveBeenLastCalledWith(ID, { fontSize: 20, font: "Ubuntu" });
    await userEvent.selectOptions(font, "System default");
    expect(commands.setNoteAppearance).toHaveBeenLastCalledWith(ID, { fontSize: 20 });
  });

  it("shows a stored font that is no longer installed", async () => {
    await open(note({ appearance: { font: "Old Font" } }));
    const font = screen.getByRole("combobox", { name: "Font" });
    await waitFor(() =>
      expect(within(font).getByRole("option", { name: "Old Font (not installed)" })).toBeInTheDocument(),
    );
    expect(font).toHaveValue("Old Font");
  });

  it("sets the width on Enter and shows the size that was applied", async () => {
    vi.mocked(commands.setNoteSize).mockResolvedValue({ width: 1920, height: 280 });
    await open();
    const width = screen.getByRole("textbox", { name: "Width" });
    expect(width).toHaveValue("300");
    await userEvent.clear(width);
    await userEvent.type(width, "5000{Enter}");
    expect(commands.setNoteSize).toHaveBeenCalledWith(ID, 5000, 280);
    await waitFor(() => expect(width).toHaveValue("1920"));
  });

  it("restores an emptied field when it loses focus and sends nothing", async () => {
    await open();
    const width = screen.getByRole("textbox", { name: "Width" });
    await userEvent.clear(width);
    await userEvent.tab();
    expect(width).toHaveValue("300");
    expect(commands.setNoteSize).not.toHaveBeenCalled();
  });

  it("keeps the aspect ratio while the lock is on", async () => {
    await open();
    await userEvent.click(screen.getByRole("switch", { name: "Lock aspect ratio" }));
    const width = screen.getByRole("textbox", { name: "Width" });
    await userEvent.clear(width);
    await userEvent.type(width, "600{Enter}");
    expect(commands.setNoteSize).toHaveBeenCalledWith(ID, 600, 560);
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Height" })).toHaveValue("560"));
  });

  it("follows the note when it is resized", async () => {
    await open();
    act(() => handlers.resized?.({ id: ID, width: 410, height: 333 }));
    expect(screen.getByRole("textbox", { name: "Width" })).toHaveValue("410");
    expect(screen.getByRole("textbox", { name: "Height" })).toHaveValue("333");
    act(() => handlers.resized?.({ id: "other", width: 900, height: 900 }));
    expect(screen.getByRole("textbox", { name: "Width" })).toHaveValue("410");
  });

  it("resets the size to 300 × 280", async () => {
    await open(note({ window: { ...note().window, width: 500, height: 400 } }));
    await userEvent.click(screen.getByRole("button", { name: "Reset size" }));
    expect(commands.setNoteSize).toHaveBeenCalledWith(ID, 300, 280);
  });

  it("resets to defaults without touching the colour or the behaviour", async () => {
    await open(note({ color: "#c8f7c5", appearance: { fontSize: 20, opacity: 85 } }));
    await userEvent.click(screen.getByRole("button", { name: "Reset to defaults" }));
    expect(commands.setNoteAppearance).toHaveBeenCalledWith(ID, {});
    expect(commands.setNoteSize).toHaveBeenCalledWith(ID, 300, 280);
    expect(commands.setNoteColor).not.toHaveBeenCalled();
    expect(commands.setEditLocked).not.toHaveBeenCalled();
    expect(commands.setAlwaysOnTop).not.toHaveBeenCalled();
    expect(screen.getByText("15")).toBeInTheDocument();
  });

  it("locks editing and turns off always on top", async () => {
    await open();
    await userEvent.click(screen.getByRole("switch", { name: "Lock editing" }));
    expect(commands.setEditLocked).toHaveBeenCalledWith(ID, true);
    await userEvent.click(screen.getByRole("switch", { name: "Always on top" }));
    expect(commands.setAlwaysOnTop).toHaveBeenCalledWith(ID, false);
    expect(screen.getByRole("switch", { name: "Always on top" })).toHaveAttribute("aria-checked", "false");
  });

  it("follows changes made elsewhere", async () => {
    await open();
    vi.mocked(commands.getNote).mockResolvedValue(note({ editLocked: true, color: "#cfe8ff" }));
    act(() => handlers.notesChanged?.({ id: ID, kind: "other" }));
    await waitFor(() =>
      expect(screen.getByRole("switch", { name: "Lock editing" })).toHaveAttribute("aria-checked", "true"),
    );
    expect(screen.getByRole("radio", { name: "Sky" })).toHaveAttribute("aria-checked", "true");
  });

  it.each([
    ["archived", { archivedAt: 5 }],
    ["trashed", { deletedAt: 5 }],
    ["hidden", { window: { ...note().window, visible: false } }],
  ])("closes when its note is %s", async (_, change) => {
    await open();
    vi.mocked(commands.getNote).mockResolvedValue(note(change as Partial<Note>));
    act(() => handlers.notesChanged?.({ id: ID, kind: "other" }));
    await waitFor(() => expect(closeCurrentWindow).toHaveBeenCalled());
  });

  it("closes when its note is gone", async () => {
    await open();
    vi.mocked(commands.getNote).mockRejectedValue(new Error("note not found"));
    act(() => handlers.notesChanged?.({ id: null, kind: "other" }));
    await waitFor(() => expect(closeCurrentWindow).toHaveBeenCalled());
  });

  it("ignores changes to other notes", async () => {
    await open();
    act(() => handlers.notesChanged?.({ id: "other", kind: "other" }));
    expect(commands.getNote).toHaveBeenCalledTimes(1);
  });

  it("switches to another note", async () => {
    await open();
    const other = note({ id: "other", color: "#ffd6e0", window: { ...note().window, width: 444 } });
    vi.mocked(commands.getNote).mockResolvedValue(other);
    act(() => handlers.switchNote?.("other"));
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Width" })).toHaveValue("444"));
    await userEvent.click(screen.getByRole("button", { name: "Larger text" }));
    expect(commands.setNoteAppearance).toHaveBeenCalledWith("other", { fontSize: 16 });
  });

  it("closes with the Close button and with Esc", async () => {
    await open();
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(closeCurrentWindow).toHaveBeenCalledTimes(1);
    await userEvent.keyboard("{Escape}");
    expect(closeCurrentWindow).toHaveBeenCalledTimes(2);
  });

  it("shows an error when a change is refused", async () => {
    await open();
    vi.mocked(commands.setNoteAppearance).mockRejectedValueOnce(new Error("font size out of range"));
    await userEvent.click(screen.getByRole("button", { name: "Larger text" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("font size out of range");
  });
});
