import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Editor } from "@tiptap/core";
import type { Appearance } from "../../types/note";
import { createExtensions } from "./extensions";

vi.mock("../../ipc/commands", () => ({
  commands: { listFonts: vi.fn(() => Promise.resolve(["Amiri", "DejaVu Sans"])) },
}));

import { TextStylePopover } from "./TextStylePopover";

const editors: Editor[] = [];
afterEach(() => {
  editors.splice(0).forEach((e) => e.destroy());
});

function makeEditor(content: string | object = "<p>Hello world</p>") {
  const editor = new Editor({ extensions: createExtensions(), content });
  editors.push(editor);
  return editor;
}

/** Renders the popover over `editor` and waits for the installed fonts to arrive. */
async function renderPopover(editor: Editor, appearance: Appearance = {}, onClose = vi.fn()) {
  const view = render(<TextStylePopover editor={editor} appearance={appearance} onClose={onClose} />);
  await screen.findByRole("option", { name: "Amiri" });
  return { ...view, onClose };
}

/** The marks on the first text run of the first paragraph. */
function firstMarks(editor: Editor) {
  return editor.getJSON().content?.[0]?.content?.[0]?.marks ?? [];
}

function select(editor: Editor, from: number, to: number) {
  act(() => {
    editor.commands.setTextSelection({ from, to });
  });
}

describe("TextStylePopover", () => {
  it("lists System default then the installed fonts", async () => {
    await renderPopover(makeEditor());
    const font = screen.getByRole("combobox", { name: "Font" });
    expect(Array.from((font as HTMLSelectElement).options).map((o) => o.textContent)).toEqual([
      "System default",
      "Amiri",
      "DejaVu Sans",
    ]);
    expect(font).toHaveValue("");
  });

  it("choosing a font sets it on the selection; System default removes it", async () => {
    const user = userEvent.setup();
    const editor = makeEditor();
    select(editor, 1, 6);
    await renderPopover(editor);
    const font = screen.getByRole("combobox", { name: "Font" });

    await user.selectOptions(font, "Amiri");
    expect(firstMarks(editor)).toEqual([{ type: "textStyle", attrs: expect.objectContaining({ fontFamily: "Amiri" }) }]);
    expect(font).toHaveValue("Amiri");

    await user.selectOptions(font, "System default");
    expect(firstMarks(editor)).toEqual([]);
    expect(font).toHaveValue("");
  });

  it("shows the selection's own font even when it is not installed", async () => {
    const editor = makeEditor('<p><span style="font-family: Comic Neue">Hi</span> there</p>');
    select(editor, 1, 3);
    await renderPopover(editor);
    expect(screen.getByRole("combobox", { name: "Font" })).toHaveValue("Comic Neue");
  });

  describe("size stepper stops at the limits", () => {
    it("disables + at 32 px", async () => {
      const editor = makeEditor('<p><span style="font-size: 32px">Big</span></p>');
      select(editor, 1, 4);
      await renderPopover(editor);
      expect(screen.getByRole("button", { name: "Larger text" })).toBeDisabled();
      expect(screen.getByRole("button", { name: "Smaller text" })).toBeEnabled();
      expect(screen.getByRole("group", { name: "Size" })).toHaveTextContent("32");
    });

    it("disables − at 10 px", async () => {
      const editor = makeEditor('<p><span style="font-size: 10px">Small</span></p>');
      select(editor, 1, 6);
      await renderPopover(editor);
      expect(screen.getByRole("button", { name: "Smaller text" })).toBeDisabled();
      expect(screen.getByRole("button", { name: "Larger text" })).toBeEnabled();
    });

    it("pressing + from the note default 15 stores 16px", async () => {
      const user = userEvent.setup();
      const editor = makeEditor();
      select(editor, 1, 6);
      await renderPopover(editor);
      expect(screen.getByRole("group", { name: "Size" })).toHaveTextContent("15");
      await user.click(screen.getByRole("button", { name: "Larger text" }));
      expect(firstMarks(editor)).toEqual([{ type: "textStyle", attrs: expect.objectContaining({ fontSize: "16px" }) }]);
      expect(screen.getByRole("group", { name: "Size" })).toHaveTextContent("16");
    });

    it("starts from the note's own size", async () => {
      const user = userEvent.setup();
      const editor = makeEditor();
      select(editor, 1, 6);
      await renderPopover(editor, { fontSize: 20 });
      await user.click(screen.getByRole("button", { name: "Smaller text" }));
      expect(firstMarks(editor)).toEqual([{ type: "textStyle", attrs: expect.objectContaining({ fontSize: "19px" }) }]);
    });
  });

  it("weight lists the four weights and sets the chosen one", async () => {
    const user = userEvent.setup();
    const editor = makeEditor();
    select(editor, 1, 6);
    await renderPopover(editor);
    const weight = screen.getByRole("combobox", { name: "Weight" });
    expect(Array.from((weight as HTMLSelectElement).options).map((o) => o.textContent)).toEqual([
      "Light",
      "Regular",
      "Medium",
      "Semibold",
    ]);
    expect(weight).toHaveValue("400");
    await user.selectOptions(weight, "Semibold");
    expect(firstMarks(editor)).toEqual([{ type: "textStyle", attrs: expect.objectContaining({ fontWeight: "600" }) }]);
  });

  it("text colour swatch sets the colour and rings it", async () => {
    const user = userEvent.setup();
    const editor = makeEditor();
    select(editor, 1, 6);
    await renderPopover(editor);
    const group = screen.getByRole("radiogroup", { name: "Text" });
    expect(group.querySelectorAll('[role="radio"]')).toHaveLength(6);
    expect(screen.getByRole("radio", { name: "Black text" })).toHaveAttribute("aria-checked", "true");

    await user.click(screen.getByRole("radio", { name: "Blue text" }));
    expect(firstMarks(editor)).toEqual([{ type: "textStyle", attrs: expect.objectContaining({ color: "#1d4f91" }) }]);
    expect(screen.getByRole("radio", { name: "Blue text" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("radio", { name: "Black text" })).toHaveAttribute("aria-checked", "false");
  });

  it("a highlight swatch sets the highlight", async () => {
    const user = userEvent.setup();
    const editor = makeEditor();
    select(editor, 1, 6);
    await renderPopover(editor);
    expect(screen.getByRole("radiogroup", { name: "Highlight" }).querySelectorAll('[role="radio"]')).toHaveLength(5);
    await user.click(screen.getByRole("radio", { name: "Peach highlight" }));
    expect(firstMarks(editor)).toEqual([{ type: "highlight", attrs: { color: "#ffc6a5" } }]);
    expect(screen.getByRole("radio", { name: "Peach highlight" })).toHaveAttribute("aria-checked", "true");
  });

  it("No highlight removes the highlight", async () => {
    const user = userEvent.setup();
    const editor = makeEditor();
    select(editor, 1, 6);
    act(() => {
      editor.chain().setHighlight({ color: "#bcd9ff" }).run();
    });
    await renderPopover(editor);
    expect(screen.getByRole("radio", { name: "No highlight" })).toHaveAttribute("aria-checked", "false");

    await user.click(screen.getByRole("radio", { name: "No highlight" }));
    expect(firstMarks(editor)).toEqual([]);
    expect(screen.getByRole("radio", { name: "No highlight" })).toHaveAttribute("aria-checked", "true");
  });

  it("arrow keys move between the swatches of a group", async () => {
    const editor = makeEditor();
    await renderPopover(editor);
    const black = screen.getByRole("radio", { name: "Black text" });
    // Only the current swatch is in the Tab order.
    expect(black).toHaveAttribute("tabindex", "0");
    expect(screen.getByRole("radio", { name: "Brown text" })).toHaveAttribute("tabindex", "-1");
    black.focus();
    fireEvent.keyDown(black, { key: "ArrowRight" });
    expect(screen.getByRole("radio", { name: "Brown text" })).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: "ArrowLeft" });
    fireEvent.keyDown(document.activeElement!, { key: "ArrowLeft" });
    expect(screen.getByRole("radio", { name: "Violet text" })).toHaveFocus();
  });

  it("align centre presses Align centre", async () => {
    const user = userEvent.setup();
    const editor = makeEditor();
    select(editor, 1, 6);
    await renderPopover(editor);
    expect(screen.getByRole("button", { name: "Align left" })).toHaveAttribute("aria-pressed", "true");

    await user.click(screen.getByRole("button", { name: "Align centre" }));
    expect(editor.getJSON().content?.[0]?.attrs?.textAlign).toBe("center");
    expect(screen.getByRole("button", { name: "Align centre" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Align left" })).toHaveAttribute("aria-pressed", "false");
  });

  it("AB is disabled without a selection", async () => {
    const editor = makeEditor();
    select(editor, 3, 3);
    await renderPopover(editor);
    expect(screen.getByRole("button", { name: "AB" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "ab" })).toBeDisabled();
  });

  it("AB and ab change the case of the selection", async () => {
    const user = userEvent.setup();
    const editor = makeEditor();
    select(editor, 1, 6);
    await renderPopover(editor);
    await user.click(screen.getByRole("button", { name: "AB" }));
    expect(editor.getText()).toBe("HELLO world");
    await user.click(screen.getByRole("button", { name: "ab" }));
    expect(editor.getText()).toBe("hello world");
  });

  it("Undo is disabled on a fresh editor; after a change it undoes it", async () => {
    const user = userEvent.setup();
    const editor = makeEditor();
    select(editor, 1, 6);
    await renderPopover(editor);
    const undo = screen.getByRole("button", { name: "Undo" });
    const redo = screen.getByRole("button", { name: "Redo" });
    expect(undo).toBeDisabled();
    expect(redo).toBeDisabled();
    expect(undo).toHaveAttribute("title", "Undo (Ctrl+Z)");
    expect(redo).toHaveAttribute("title", "Redo (Ctrl+Shift+Z)");

    await user.click(screen.getByRole("button", { name: "AB" }));
    expect(undo).toBeEnabled();
    await user.click(undo);
    expect(editor.getText()).toBe("Hello world");
    expect(redo).toBeEnabled();
    await user.click(redo);
    expect(editor.getText()).toBe("HELLO world");
  });

  it("Escape calls onClose", async () => {
    const { onClose } = await renderPopover(makeEditor());
    fireEvent.keyDown(screen.getByRole("dialog", { name: "Text style" }), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("Escape in the editor while it is open calls onClose", async () => {
    const editor = makeEditor();
    document.body.appendChild(editor.view.dom);
    const { onClose } = await renderPopover(editor);
    fireEvent.keyDown(editor.view.dom, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    editor.view.dom.remove();
  });

  it("a click outside calls onClose, but not one on a popover toggle", async () => {
    const toggle = document.createElement("button");
    toggle.setAttribute("data-popover-toggle", "");
    document.body.appendChild(toggle);
    const { onClose } = await renderPopover(makeEditor());

    fireEvent.pointerDown(screen.getByRole("radio", { name: "Blue text" }));
    fireEvent.pointerDown(toggle);
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.pointerDown(document.body);
    expect(onClose).toHaveBeenCalledTimes(1);
    toggle.remove();
  });

  it("keeps the popover open after a choice", async () => {
    const user = userEvent.setup();
    const editor = makeEditor();
    select(editor, 1, 6);
    const { onClose } = await renderPopover(editor);
    await user.click(screen.getByRole("radio", { name: "Red text" }));
    await user.click(screen.getByRole("button", { name: "Larger text" }));
    await user.selectOptions(screen.getByRole("combobox", { name: "Font" }), "DejaVu Sans");
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Text style" })).toBeInTheDocument();
  });

  it("does not take focus when it opens", async () => {
    const editor = makeEditor();
    const before = document.activeElement;
    await renderPopover(editor);
    expect(document.activeElement).toBe(before);
  });
});

describe("TextStylePopover fonts", () => {
  it("shows only System default when the fonts cannot be listed", async () => {
    vi.resetModules();
    const { commands } = await import("../../ipc/commands");
    vi.mocked(commands.listFonts).mockRejectedValueOnce(new Error("fc-list failed"));
    const { TextStylePopover: Fresh } = await import("./TextStylePopover");
    render(<Fresh editor={makeEditor()} appearance={{}} onClose={() => {}} />);
    await act(async () => {
      await Promise.resolve();
    });
    const font = screen.getByRole("combobox", { name: "Font" }) as HTMLSelectElement;
    expect(Array.from(font.options).map((o) => o.textContent)).toEqual(["System default"]);
    expect(commands.listFonts).toHaveBeenCalledTimes(1);
  });

  it("asks for the fonts once per window", async () => {
    vi.resetModules();
    const { commands } = await import("../../ipc/commands");
    const { TextStylePopover: Fresh } = await import("./TextStylePopover");
    const first = render(<Fresh editor={makeEditor()} appearance={{}} onClose={() => {}} />);
    await screen.findByRole("option", { name: "Amiri" });
    first.unmount();
    render(<Fresh editor={makeEditor()} appearance={{}} onClose={() => {}} />);
    await screen.findByRole("option", { name: "Amiri" });
    expect(commands.listFonts).toHaveBeenCalledTimes(1);
  });
});
