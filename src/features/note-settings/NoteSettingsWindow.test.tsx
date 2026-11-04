import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { NoteResized, NotesChanged } from "../../ipc/events";
import { APP_APPEARANCE_DEFAULTS, type AppAppearance, type Note } from "../../types/note";

const handlers: {
  appAppearance?: (a: AppAppearance) => void;
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
  onAppAppearanceChanged: (h: (a: AppAppearance) => void) => {
    handlers.appAppearance = h;
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
    getAppAppearance: vi.fn(),
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
    vi.mocked(commands.getAppAppearance).mockResolvedValue({ ...APP_APPEARANCE_DEFAULTS });
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

  describe("switching note", () => {
    function deferred<T>() {
      let resolve!: (v: T) => void;
      const promise = new Promise<T>((r) => (resolve = r));
      return { promise, resolve };
    }
    const OTHER = "other";
    const other = (over: Partial<Note> = {}) => note({ id: OTHER, color: "#ffd6e0", ...over });

    it("sends a waiting slider value to the old note only and shows the new note's settings", async () => {
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
        fireEvent.change(slider, { target: { value: "160" } }); // waiting for the 100 ms
        vi.mocked(commands.getNote).mockResolvedValue(other({ appearance: { fontSize: 20 } }));
        act(() => handlers.switchNote?.(OTHER));
        expect(commands.setNoteAppearance).toHaveBeenLastCalledWith(ID, { lineSpacing: 160 });
        await act(async () => {
          await vi.advanceTimersByTimeAsync(500);
        });
        expect(screen.getByText("145 %")).toBeInTheDocument();
        expect(screen.getByText("20")).toBeInTheDocument();
        fireEvent.click(screen.getByRole("button", { name: "Larger text" }));
        expect(commands.setNoteAppearance).toHaveBeenLastCalledWith(OTHER, { fontSize: 21 });
        const toOther = vi.mocked(commands.setNoteAppearance).mock.calls.filter(([id]) => id === OTHER);
        expect(toOther).toEqual([[OTHER, { fontSize: 21 }]]);
      } finally {
        vi.useRealTimers();
      }
    });

    it("shows the new note's settings even while a change to the old note is unanswered", async () => {
      await open();
      const oldSend = deferred<void>();
      vi.mocked(commands.setNoteAppearance).mockReturnValueOnce(oldSend.promise);
      await userEvent.click(screen.getByRole("button", { name: "Larger text" }));
      expect(commands.setNoteAppearance).toHaveBeenLastCalledWith(ID, { fontSize: 16 });

      const read = deferred<Note>();
      vi.mocked(commands.getNote).mockReturnValueOnce(read.promise);
      act(() => handlers.switchNote?.(OTHER));
      // Nothing of the old note can be changed or seen while the new one is read.
      expect(screen.queryByRole("button", { name: "Larger text" })).toBeNull();
      expect(screen.queryByRole("img", { name: "Note colour" })).toBeNull();
      expect(screen.getByRole("button", { name: "Reset to defaults" })).toBeDisabled();

      await act(async () => read.resolve(other({ appearance: { opacity: 90 }, editLocked: true })));
      expect(screen.getByText("90 %")).toBeInTheDocument();
      expect(screen.getByText("15")).toBeInTheDocument();
      expect(screen.getByRole("img", { name: "Note colour" })).toHaveStyle({ backgroundColor: "#ffd6e0" });
      expect(screen.getByRole("switch", { name: "Lock editing" })).toHaveAttribute("aria-checked", "true");
      await act(async () => oldSend.resolve());

      await userEvent.click(screen.getByRole("button", { name: "Larger text" }));
      expect(commands.setNoteAppearance).toHaveBeenLastCalledWith(OTHER, { opacity: 90, fontSize: 16 });
    });

    it("does not show the old note's error on the new note", async () => {
      await open();
      const oldSend = deferred<void>();
      vi.mocked(commands.setNoteAppearance).mockReturnValueOnce(
        oldSend.promise.then(() => Promise.reject(new Error("old note refused"))),
      );
      await userEvent.click(screen.getByRole("button", { name: "Larger text" }));
      vi.mocked(commands.getNote).mockResolvedValue(other());
      act(() => handlers.switchNote?.(OTHER));
      await screen.findByRole("img", { name: "Note colour" });
      await act(async () => oldSend.resolve());
      expect(screen.queryByRole("alert")).toBeNull();
    });

    it("reads the note again when asked to show the note it already shows", async () => {
      await open(note({ appearance: { fontSize: 20 }, window: { ...note().window, width: 410 } }));
      act(() => handlers.switchNote?.(ID));
      expect(await screen.findByRole("button", { name: "Larger text" })).toBeInTheDocument();
      expect(commands.getNote).toHaveBeenCalledTimes(2);
      expect(screen.getByText("20")).toBeInTheDocument();
      expect(screen.getByRole("textbox", { name: "Width" })).toHaveValue("410");
      expect(screen.getByRole("img", { name: "Note colour" })).toBeInTheDocument();
    });

    it("shows nothing until the new note's first read, even if another read lands before it", async () => {
      await open();
      const first = deferred<Note>();
      vi.mocked(commands.getNote).mockReturnValueOnce(first.promise);
      act(() => handlers.switchNote?.(OTHER));
      vi.mocked(commands.getNote).mockResolvedValueOnce(other({ color: "#cfe8ff" }));
      await act(async () => handlers.notesChanged?.({ id: OTHER, kind: "other" }));
      expect(commands.getNote).toHaveBeenCalledTimes(3);
      expect(screen.queryByRole("textbox", { name: "Width" })).toBeNull();
      expect(screen.queryByRole("img", { name: "Note colour" })).toBeNull();
      await act(async () => first.resolve(other({ window: { ...note().window, width: 444, height: 333 } })));
      expect(screen.getByRole("textbox", { name: "Width" })).toHaveValue("444");
      expect(screen.getByRole("textbox", { name: "Height" })).toHaveValue("333");
    });

    it("ignores a resize of the old note that answers after the switch", async () => {
      await open();
      const oldResize = deferred<{ width: number; height: number }>();
      vi.mocked(commands.setNoteSize).mockReturnValueOnce(oldResize.promise);
      const width = screen.getByRole("textbox", { name: "Width" });
      await userEvent.clear(width);
      await userEvent.type(width, "500{Enter}");
      expect(commands.setNoteSize).toHaveBeenCalledWith(ID, 500, 280);

      vi.mocked(commands.getNote).mockResolvedValue(other({ window: { ...note().window, width: 444, height: 333 } }));
      act(() => handlers.switchNote?.(OTHER));
      await waitFor(() => expect(screen.getByRole("textbox", { name: "Width" })).toHaveValue("444"));
      await act(async () => oldResize.resolve({ width: 500, height: 280 }));
      expect(screen.getByRole("textbox", { name: "Width" })).toHaveValue("444");
      expect(screen.getByRole("textbox", { name: "Height" })).toHaveValue("333");

      await userEvent.click(screen.getByRole("textbox", { name: "Width" }));
      await userEvent.tab(); // leaving an unchanged field sends nothing
      expect(vi.mocked(commands.setNoteSize).mock.calls.filter(([id]) => id === OTHER)).toEqual([]);
    });
  });

  it("closes with the Close button and with Esc", async () => {
    await open();
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(closeCurrentWindow).toHaveBeenCalledTimes(1);
    await userEvent.keyboard("{Escape}");
    expect(closeCurrentWindow).toHaveBeenCalledTimes(2);
  });

  describe.each([
    ["the Close button", () => fireEvent.click(screen.getByRole("button", { name: "Close" }))],
    ["Esc", () => fireEvent.keyDown(document, { key: "Escape" })],
  ])("closing with %s while a slider value is waiting for its 100 ms", (_name, close) => {
    it("sends that value first", async () => {
      vi.useFakeTimers();
      try {
        vi.mocked(commands.getNote).mockResolvedValue(note());
        render(<NoteSettingsWindow noteId={ID} />);
        await act(async () => {
          await vi.runOnlyPendingTimersAsync();
        });
        const slider = screen.getByRole("slider", { name: "Line spacing" });
        fireEvent.pointerDown(slider);
        fireEvent.change(slider, { target: { value: "150" } }); // goes out at once
        fireEvent.change(slider, { target: { value: "160" } }); // waits
        expect(commands.setNoteAppearance).toHaveBeenCalledTimes(1);
        close();
        expect(commands.setNoteAppearance).toHaveBeenCalledTimes(2);
        expect(commands.setNoteAppearance).toHaveBeenLastCalledWith(ID, { lineSpacing: 160 });
        expect(closeCurrentWindow).toHaveBeenCalledTimes(1);
        expect(vi.mocked(commands.setNoteAppearance).mock.invocationCallOrder[1]!).toBeLessThan(
          vi.mocked(closeCurrentWindow).mock.invocationCallOrder[0]!,
        );
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it("reads the disabled background image row as 'Background image Later', not 'Background imageLater'", async () => {
    await open();
    const row = screen.getByText("Background image").closest(".dn-ns-row") as HTMLElement;
    expect(row).toHaveAttribute("aria-disabled", "true");
    expect(row.textContent).toBe("Background image Later");
  });

  it("shows an error when a change is refused", async () => {
    await open();
    vi.mocked(commands.setNoteAppearance).mockRejectedValueOnce(new Error("font size out of range"));
    await userEvent.click(screen.getByRole("button", { name: "Larger text" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("font size out of range");
  });

  describe("app appearance", () => {
    const appLook = (over: Partial<AppAppearance> = {}): AppAppearance => ({ ...APP_APPEARANCE_DEFAULTS, ...over });
    const sizeShown = () =>
      within(screen.getByRole("group", { name: "Size" })).getByText(/^\d+$/).textContent;

    it("popover and note settings use the effective size: Size shows the app default", async () => {
      vi.mocked(commands.getAppAppearance).mockResolvedValue(appLook({ defaultSize: 18 }));
      await open();
      expect(sizeShown()).toBe("18");
      // The stepper steps from the shown value and stores the note's own size only.
      await userEvent.click(screen.getByRole("button", { name: "Smaller text" }));
      expect(commands.setNoteAppearance).toHaveBeenLastCalledWith(ID, { fontSize: 17 });
    });

    it("keeps a note's own 15 when the app default is not 15", async () => {
      vi.mocked(commands.getAppAppearance).mockResolvedValue(appLook({ defaultSize: 16 }));
      await open();
      await userEvent.click(screen.getByRole("button", { name: "Smaller text" }));
      expect(commands.setNoteAppearance).toHaveBeenLastCalledWith(ID, { fontSize: 15 });
      expect(sizeShown()).toBe("15");
      // Back to the app default: the note follows the app again.
      await userEvent.click(screen.getByRole("button", { name: "Larger text" }));
      expect(commands.setNoteAppearance).toHaveBeenLastCalledWith(ID, {});
    });

    it("shows the compact default size rounded to whole pixels, and steps from it", async () => {
      vi.mocked(commands.getAppAppearance).mockResolvedValue(appLook({ layout: "compact" }));
      await open();
      expect(sizeShown()).toBe("14"); // 13.5 drawn
      await userEvent.click(screen.getByRole("button", { name: "Larger text" }));
      expect(commands.setNoteAppearance).toHaveBeenLastCalledWith(ID, { fontSize: 15 });
    });

    it("never drops a note's own size equal to the app default when something else changes", async () => {
      vi.mocked(commands.getAppAppearance).mockResolvedValue(appLook({ defaultSize: 18 }));
      await open(note({ appearance: { fontSize: 18 } }));
      await userEvent.click(screen.getByRole("radio", { name: "Blue text" }));
      expect(commands.setNoteAppearance).toHaveBeenLastCalledWith(ID, { fontSize: 18, textColor: "#1d4f91" });
    });

    it("shows the note's own size over the app default", async () => {
      vi.mocked(commands.getAppAppearance).mockResolvedValue(appLook({ defaultSize: 18, layout: "compact" }));
      await open(note({ appearance: { fontSize: 20 } }));
      expect(sizeShown()).toBe("20");
    });

    it("follows the app default while open, without storing anything", async () => {
      await open();
      expect(sizeShown()).toBe("15");
      await act(async () => handlers.appAppearance?.(appLook({ defaultSize: 22 })));
      expect(sizeShown()).toBe("22");
      expect(commands.setNoteAppearance).not.toHaveBeenCalled();
    });
  });
});
