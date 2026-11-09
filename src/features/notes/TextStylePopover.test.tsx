import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Editor } from "@tiptap/core";
import type { Appearance } from "../../types/note";
import { createExtensions } from "./extensions";

vi.mock("../../ipc/commands", () => ({
  commands: { listFonts: vi.fn(() => Promise.resolve(["Amiri", "DejaVu Sans"])) },
}));

import { LinkEditor } from "./LinkEditor";
import { TextStylePopover } from "./TextStylePopover";

const editors: Editor[] = [];
afterEach(() => {
  editors.splice(0).forEach((e) => {
    const parent = e.view.dom.parentElement;
    e.destroy();
    parent?.remove();
  });
});

/** A real editor in the document, so its focus() can really take focus. */
function makeEditor(content: string | object = "<p>Hello world</p>") {
  const element = document.body.appendChild(document.createElement("div"));
  const editor = new Editor({ element, extensions: createExtensions(), content });
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
  return marksOf(editor, 0);
}

/** The marks on the first text run of the block at `index`. */
function marksOf(editor: Editor, index: number) {
  return editor.getJSON().content?.[index]?.content?.[0]?.marks ?? [];
}

/**
 * The note's typography from note.css with the note size at 15 px (the title line
 * ×18/15, headings ×16.5/15, both bold), written out because jsdom resolves
 * neither calc() nor var().
 */
function addNoteStyles() {
  const style = document.head.appendChild(document.createElement("style"));
  style.textContent = `
    .tiptap { font-size: 15px; font-weight: 400; }
    .tiptap h2 { font-size: 16.5px; font-weight: 700; }
    .tiptap > p:first-child, .tiptap > h2:first-child { font-size: 18px; font-weight: 700; }
  `;
  return style;
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
      // The second paragraph: the first line is the title and is drawn larger.
      const editor = makeEditor("<p>Title</p><p>Hello world</p>");
      select(editor, 8, 13);
      await renderPopover(editor);
      expect(screen.getByRole("group", { name: "Size" })).toHaveTextContent("15");
      await user.click(screen.getByRole("button", { name: "Larger text" }));
      expect(marksOf(editor, 1)).toEqual([{ type: "textStyle", attrs: expect.objectContaining({ fontSize: "16px" }) }]);
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

  describe("title line and headings show what the text shows", () => {
    let style: HTMLStyleElement;
    beforeEach(() => {
      style = addNoteStyles();
    });
    afterEach(() => style.remove());

    it("the title line shows 18 for a 15 px note, and + stores 19px", async () => {
      const user = userEvent.setup();
      const editor = makeEditor("<p>Title</p><p>Body</p>");
      select(editor, 1, 6);
      await renderPopover(editor);
      expect(screen.getByRole("group", { name: "Size" })).toHaveTextContent("18");
      await user.click(screen.getByRole("button", { name: "Larger text" }));
      expect(firstMarks(editor)).toEqual([{ type: "textStyle", attrs: expect.objectContaining({ fontSize: "19px" }) }]);
      expect(screen.getByRole("group", { name: "Size" })).toHaveTextContent("19");
    });

    it("a heading shows 17 (16.5 rounded), and − stores 16px", async () => {
      const user = userEvent.setup();
      const editor = makeEditor("<p>Title</p><h2>Heading</h2>");
      select(editor, 8, 15);
      await renderPopover(editor);
      expect(screen.getByRole("group", { name: "Size" })).toHaveTextContent("17");
      await user.click(screen.getByRole("button", { name: "Smaller text" }));
      expect(marksOf(editor, 1)).toEqual([{ type: "textStyle", attrs: expect.objectContaining({ fontSize: "16px" }) }]);
    });

    it("follows the note's size and shows at most 32 (a 32 px note has a 38 px title)", async () => {
      const user = userEvent.setup();
      const editor = makeEditor("<p>Title</p><p>Body</p>");
      select(editor, 1, 6);
      await renderPopover(editor, { fontSize: 32 });
      expect(screen.getByRole("group", { name: "Size" })).toHaveTextContent("32");
      expect(screen.getByRole("button", { name: "Larger text" })).toBeDisabled();
      await user.click(screen.getByRole("button", { name: "Smaller text" }));
      expect(firstMarks(editor)).toEqual([{ type: "textStyle", attrs: expect.objectContaining({ fontSize: "31px" }) }]);
    });

    it("a bold title never shows Regular, and Regular makes it regular", async () => {
      const user = userEvent.setup();
      const editor = makeEditor("<p>Title</p><p>Body</p>");
      select(editor, 1, 6);
      await renderPopover(editor);
      const weight = screen.getByRole("combobox", { name: "Weight" });
      // 700 is not one of the choices: it shows as Bold, which cannot be picked.
      expect(weight).toHaveValue("700");
      expect(weight).toHaveDisplayValue("Bold");
      expect(weight.querySelector('option[value="700"]')).toBeDisabled();
      await user.selectOptions(weight, "Regular");
      expect(firstMarks(editor)).toEqual([{ type: "textStyle", attrs: expect.objectContaining({ fontWeight: "400" }) }]);
      expect(weight).toHaveValue("400");
    });

    it("bold text in a body paragraph still shows Regular (Bold is the B button)", async () => {
      const editor = makeEditor("<p>Title</p><p><strong>Body</strong></p>");
      select(editor, 8, 12);
      await renderPopover(editor);
      expect(screen.getByRole("combobox", { name: "Weight" })).toHaveValue("400");
    });
  });

  it("Semibold on a bold title is a change: it stores 600 (DES-33)", async () => {
    const user = userEvent.setup();
    const editor = makeEditor("<p>Title</p><p>Body</p>");
    select(editor, 1, 6);
    await renderPopover(editor);
    await user.selectOptions(screen.getByRole("combobox", { name: "Weight" }), "Semibold");
    expect(firstMarks(editor)).toEqual([{ type: "textStyle", attrs: expect.objectContaining({ fontWeight: "600" }) }]);
  });

  it("with paragraphs aligned differently, no alignment shows as chosen (DES-33)", async () => {
    const editor = makeEditor('<p style="text-align: center">One</p><p>Two</p>');
    select(editor, 1, 9);
    await renderPopover(editor);
    for (const name of ["Align left", "Align centre", "Align right"]) {
      expect(screen.getByRole("button", { name })).toHaveAttribute("aria-pressed", "false");
    }
    select(editor, 1, 3);
    await waitFor(() => expect(screen.getByRole("button", { name: "Align centre" })).toHaveAttribute("aria-pressed", "true"));
  });

  it("an Esc in the link editor closes only the link editor (DES-33)", async () => {
    const editor = makeEditor();
    const { onClose } = await renderPopover(editor);
    const closeLink = vi.fn();
    render(<LinkEditor editor={editor} onClose={closeLink} />);
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Link address" }), { key: "Escape" });
    expect(closeLink).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
    // An Esc the editor has marked as handled (WebKitGTK does) still closes the popover.
    const esc = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    editor.view.dom.addEventListener("keydown", (e) => e.preventDefault(), { once: true });
    document.body.appendChild(editor.view.dom);
    try {
      editor.view.dom.dispatchEvent(esc);
      expect(onClose).toHaveBeenCalledTimes(1);
    } finally {
      editor.view.dom.remove();
    }
  });

  it("listens to the document once, not again on every render (DES-33)", async () => {
    const add = vi.spyOn(document, "addEventListener");
    try {
      const editor = makeEditor();
      const { rerender } = render(<TextStylePopover editor={editor} appearance={{}} onClose={vi.fn()} />);
      const before = add.mock.calls.filter(([type]) => type === "keydown").length;
      const onClose = vi.fn();
      rerender(<TextStylePopover editor={editor} appearance={{}} onClose={onClose} />);
      expect(add.mock.calls.filter(([type]) => type === "keydown").length).toBe(before);
      // The newest onClose is the one called.
      fireEvent.keyDown(document.body, { key: "Escape" });
      expect(onClose).toHaveBeenCalledTimes(1);
    } finally {
      add.mockRestore();
    }
  });

  describe("alignment in Automatic direction follows each paragraph's own direction", () => {
    const arabic = "<p>مرحبا بالعالم</p>";

    it("an Arabic paragraph with no stored alignment shows Align right pressed", async () => {
      const editor = makeEditor(arabic);
      select(editor, 1, 6);
      await renderPopover(editor, { direction: "auto" });
      expect(screen.getByRole("button", { name: "Align right" })).toHaveAttribute("aria-pressed", "true");
      expect(screen.getByRole("button", { name: "Align left" })).toHaveAttribute("aria-pressed", "false");
    });

    it("Align left on it stores left; Align right stores nothing", async () => {
      const user = userEvent.setup();
      const editor = makeEditor(arabic);
      select(editor, 1, 6);
      await renderPopover(editor, { direction: "auto" });
      await user.click(screen.getByRole("button", { name: "Align left" }));
      expect(editor.getJSON().content?.[0]?.attrs?.textAlign).toBe("left");
      expect(screen.getByRole("button", { name: "Align left" })).toHaveAttribute("aria-pressed", "true");
      await user.click(screen.getByRole("button", { name: "Align right" }));
      expect(editor.getJSON().content?.[0]?.attrs?.textAlign ?? null).toBeNull();
      expect(screen.getByRole("button", { name: "Align right" })).toHaveAttribute("aria-pressed", "true");
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
    const { onClose } = await renderPopover(editor);
    fireEvent.keyDown(editor.view.dom, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("a click outside calls onClose, but not one on a popover toggle", async () => {
    const toggle = document.createElement("button");
    toggle.setAttribute("data-popover-toggle", "");
    document.body.appendChild(toggle);
    try {
      const { onClose } = await renderPopover(makeEditor());
      fireEvent.pointerDown(screen.getByRole("radio", { name: "Blue text" }));
      fireEvent.pointerDown(toggle);
      expect(onClose).not.toHaveBeenCalled();
      fireEvent.pointerDown(document.body);
      expect(onClose).toHaveBeenCalledTimes(1);
    } finally {
      toggle.remove(); // even when an expectation fails
    }
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

  describe("keyboard use keeps focus in the popover", () => {
    it("a colour picked with the keyboard leaves focus on the swatch", async () => {
      const user = userEvent.setup();
      const editor = makeEditor();
      select(editor, 1, 6);
      await renderPopover(editor);
      const blue = screen.getByRole("radio", { name: "Blue text" });
      blue.focus();
      await user.keyboard("{Enter}");
      // tiptap's focus() moves focus a frame later.
      await act(() => new Promise((r) => requestAnimationFrame(() => r(null))));
      expect(firstMarks(editor)).toEqual([{ type: "textStyle", attrs: expect.objectContaining({ color: "#1d4f91" }) }]);
      expect(document.activeElement).toBe(blue);
    });

    it("changing the font with the select keeps focus in the popover", async () => {
      const editor = makeEditor();
      select(editor, 1, 6);
      await renderPopover(editor);
      const font = screen.getByRole("combobox", { name: "Font" });
      font.focus();
      fireEvent.change(font, { target: { value: "Amiri" } });
      await act(() => new Promise((r) => requestAnimationFrame(() => r(null))));
      expect(firstMarks(editor)).toEqual([{ type: "textStyle", attrs: expect.objectContaining({ fontFamily: "Amiri" }) }]);
      expect(document.activeElement).toBe(font);
    });

    it("the stepper, weight, align, highlight and undo keep focus too", async () => {
      const user = userEvent.setup();
      const editor = makeEditor();
      select(editor, 1, 6);
      await renderPopover(editor);
      const frame = () => act(() => new Promise((r) => requestAnimationFrame(() => r(null))));
      for (const name of ["Larger text", "Align centre"]) {
        const b = screen.getByRole("button", { name });
        b.focus();
        await user.keyboard("{Enter}");
        await frame();
        expect(document.activeElement).toBe(b);
      }
      const peach = screen.getByRole("radio", { name: "Peach highlight" });
      peach.focus();
      await user.keyboard(" ");
      await frame();
      expect(document.activeElement).toBe(peach);
      const weight = screen.getByRole("combobox", { name: "Weight" });
      weight.focus();
      fireEvent.change(weight, { target: { value: "300" } });
      await frame();
      expect(document.activeElement).toBe(weight);
      expect(editor.getJSON().content?.[0]?.attrs?.textAlign).toBe("center");
      expect(firstMarks(editor)).toEqual([
        { type: "textStyle", attrs: expect.objectContaining({ fontSize: "16px", fontWeight: "300" }) },
        { type: "highlight", attrs: { color: "#ffc6a5" } },
      ]);
      for (const name of ["Undo", "Redo"]) {
        const b = screen.getByRole("button", { name });
        b.focus();
        await user.keyboard("{Enter}");
        await frame();
        expect(document.activeElement).toBe(b);
      }
    });
  });

  it("a press anywhere in the popover keeps the editor's focus, except on a select", async () => {
    await renderPopover(makeEditor());
    // fireEvent returns false when the default was prevented.
    expect(fireEvent.mouseDown(screen.getByText("Font"))).toBe(false);
    expect(fireEvent.mouseDown(screen.getByRole("dialog", { name: "Text style" }))).toBe(false);
    expect(fireEvent.mouseDown(screen.getByRole("radio", { name: "Blue text" }))).toBe(false);
    expect(fireEvent.mouseDown(screen.getByRole("combobox", { name: "Font" }))).toBe(true);
    expect(fireEvent.mouseDown(screen.getByRole("combobox", { name: "Weight" }))).toBe(true);
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

  it("shows a font in the text plainly, not as \"not installed\", when the fonts cannot be listed (DES-35)", async () => {
    vi.resetModules();
    const { commands } = await import("../../ipc/commands");
    vi.mocked(commands.listFonts).mockRejectedValueOnce(new Error("fc-list failed"));
    const { TextStylePopover: Fresh } = await import("./TextStylePopover");
    const editor = makeEditor('<p><span style="font-family: Amiri">Hello</span></p>');
    select(editor, 1, 6);
    render(<Fresh editor={editor} appearance={{}} onClose={() => {}} />);
    await act(async () => {
      await Promise.resolve();
    });
    const font = screen.getByRole("combobox", { name: "Font" }) as HTMLSelectElement;
    expect(Array.from(font.options).map((o) => o.textContent)).toEqual(["System default", "Amiri"]);
  });

  it("asks again on the next open after a failure", async () => {
    vi.resetModules();
    const { commands } = await import("../../ipc/commands");
    vi.mocked(commands.listFonts).mockClear();
    vi.mocked(commands.listFonts).mockRejectedValueOnce(new Error("fc-list failed"));
    const { TextStylePopover: Fresh } = await import("./TextStylePopover");
    const first = render(<Fresh editor={makeEditor()} appearance={{}} onClose={() => {}} />);
    await act(async () => {
      await Promise.resolve();
    });
    first.unmount();
    render(<Fresh editor={makeEditor()} appearance={{}} onClose={() => {}} />);
    await screen.findByRole("option", { name: "Amiri" });
    expect(commands.listFonts).toHaveBeenCalledTimes(2);
  });

  it("offers only font names a note may store", async () => {
    vi.resetModules();
    const { commands } = await import("../../ipc/commands");
    vi.mocked(commands.listFonts).mockResolvedValueOnce(["Amiri", 'Bad "Quote"', "Semi;colon", "DejaVu Sans"]);
    const { TextStylePopover: Fresh } = await import("./TextStylePopover");
    render(<Fresh editor={makeEditor()} appearance={{}} onClose={() => {}} />);
    await screen.findByRole("option", { name: "Amiri" });
    const font = screen.getByRole("combobox", { name: "Font" }) as HTMLSelectElement;
    expect(Array.from(font.options).map((o) => o.textContent)).toEqual(["System default", "Amiri", "DejaVu Sans"]);
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
