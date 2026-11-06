import { Editor, type JSONContent } from "@tiptap/core";
import { NodeSelection, TextSelection } from "@tiptap/pm/state";

vi.mock("../../ipc/commands", async (importOriginal) => ({
  CommandError: (await importOriginal<typeof import("../../ipc/commands")>()).CommandError,
  commands: { addImage: vi.fn(), pickImage: vi.fn() },
}));

import { CommandError, commands } from "../../ipc/commands";
import { setImageUrlResolver } from "../../ipc/images";
import { createExtensions, sanitizeDoc } from "./extensions";
import {
  addImageFiles,
  checkImageFile,
  imageFilesIn,
  imageProblemText,
  insertImage,
  MAX_IMAGE_INPUT_BYTES,
  pasteSource,
  pickImage,
  problemOf,
  shouldPasteFiles,
  type ImageProblem,
} from "./imageInput";

setImageUrlResolver((id) => `desknotes-image://localhost/${id}`);

const NOTE = "note-1";
const ID = "1".repeat(64);
const ID2 = "2".repeat(64);
const info = (id = ID) => ({ id, width: 800, height: 450 });

const para = (text?: string): JSONContent => (text ? { type: "paragraph", content: [{ type: "text", text }] } : { type: "paragraph" });
const img = (id = ID): JSONContent => ({ type: "image", attrs: { id, width: null } });
const pngFile = (name = "a.png", bytes = [137, 80, 78, 71]) => new File([new Uint8Array(bytes)], name, { type: "image/png" });

let editor: Editor;
const editorWith = (...content: JSONContent[]) => {
  editor = new Editor({ extensions: createExtensions(), content: { type: "doc", content } });
  return editor;
};
afterEach(() => editor?.destroy());
beforeEach(() => vi.clearAllMocks());

/** The document as saved (the editor's own JSON adds textAlign: null to every line). */
const content = () => sanitizeDoc(editor.getJSON()).content;
const types = () => content()!.map((n) => n.type);

describe("imageProblemText", () => {
  it("gives the three messages verbatim", () => {
    expect(imageProblemText("too_large")).toBe("That image is too large. Images can be up to 5 MB.");
    expect(imageProblemText("unsupported")).toBe("DeskNotes can add PNG, JPEG, GIF or WebP images.");
    expect(imageProblemText("failed")).toBe("That image could not be added.");
  });
});

describe("checkImageFile", () => {
  it("refuses a file over 40 MB before sending it", () => {
    const big = pngFile();
    Object.defineProperty(big, "size", { value: 41 * 1024 * 1024 });
    expect(checkImageFile(big)).toBe<ImageProblem>("too_large");
    expect(MAX_IMAGE_INPUT_BYTES).toBe(40 * 1024 * 1024);
    const limit = pngFile();
    Object.defineProperty(limit, "size", { value: 40 * 1024 * 1024 });
    expect(checkImageFile(limit)).toBeNull();
  });

  it("sends any image type, or none, to the core, which decides from the bytes", () => {
    // The type comes from the file name, so a JPEG named "photo" has none.
    for (const type of ["image/png", "image/jpeg", "image/gif", "image/webp", "image/bmp", "image/x-unknown", ""]) {
      expect(checkImageFile(new File(["x"], "f", { type }))).toBeNull();
    }
  });

  it("refuses SVG and files typed as something other than an image", () => {
    for (const type of ["image/svg+xml", "IMAGE/SVG+XML", "application/pdf", "text/plain", "video/mp4"]) {
      expect(checkImageFile(new File(["x"], "f", { type }))).toBe<ImageProblem>("unsupported");
    }
  });
});

describe("problemOf", () => {
  it("maps the core's refusals to messages", () => {
    expect(problemOf(new CommandError("image_too_large", "x"))).toBe("too_large");
    expect(problemOf(new CommandError("image_unsupported", "x"))).toBe("unsupported");
    expect(problemOf(new CommandError("image_unreadable", "x"))).toBe("failed");
    expect(problemOf(new CommandError("io", "x"))).toBe("failed");
    expect(problemOf(new Error("boom"))).toBe("failed");
  });
});

describe("imageFilesIn", () => {
  it("keeps image files and untyped files, which may be images", () => {
    const text = new File(["x"], "a.txt", { type: "text/plain" });
    const pdf = new File(["x"], "a.pdf", { type: "application/pdf" });
    const svg = new File(["x"], "a.svg", { type: "image/svg+xml" });
    const untyped = new File([new Uint8Array([0xff, 0xd8, 0xff])], "photo", { type: "" });
    const png = pngFile();
    expect(imageFilesIn([text, svg, pdf, untyped, png])).toEqual([svg, untyped, png]);
    expect(imageFilesIn(null)).toEqual([]);
  });
});

describe("shouldPasteFiles", () => {
  it("html_with_text_and_bitmap_pastes_as_text", () => {
    // Word, Excel and LibreOffice put a picture of the copied range next to its HTML.
    const html = "<p>Hello</p><table><tr><td>1</td><td>2</td></tr></table>";
    expect(shouldPasteFiles(html, [pngFile()])).toBe(false);
  });

  it("lone_img_html_with_file_pastes_the_image", () => {
    // A browser's "Copy Image".
    expect(shouldPasteFiles('<meta charset="utf-8"><img src="https://x/a.png">', [pngFile()])).toBe(true);
  });

  it("empty html with a file pastes the image", () => {
    expect(shouldPasteFiles("", [pngFile()])).toBe(true);
  });

  it("wrappers, comments and whitespace do not count; any text or other element does", () => {
    const files = [pngFile()];
    expect(
      shouldPasteFiles(
        '<html><body>\n<!--StartFragment--><div><img src="https://x/a.png"></div> <!--EndFragment-->\n</body></html>',
        files,
      ),
    ).toBe(true);
    expect(shouldPasteFiles('<img src="https://x/a.png"> caption', files)).toBe(false);
    expect(shouldPasteFiles("<table><tr><td></td></tr></table>", files)).toBe(false);
    expect(shouldPasteFiles("<ul><li></li></ul>", files)).toBe(false);
  });

  it("no files: never", () => {
    expect(shouldPasteFiles("", [])).toBe(false);
  });
});

describe("pasteSource", () => {
  const IMG = '<meta charset="utf-8"><img src="https://x/a.png">';

  it("an empty clipboard as WebKitGTK shows a screenshot is read natively", () => {
    expect(pasteSource([], "", [])).toBe("native");
  });

  it("plain text is the editor's", () => {
    expect(pasteSource(["text/plain"], "", [])).toBe("default");
  });

  it("a browser's Copy Image (HTML holding a lone <img>) is read natively", () => {
    expect(pasteSource(["text/html"], IMG, [])).toBe("native");
  });

  it("HTML with text is the editor's", () => {
    expect(pasteSource(["text/html"], "<p>text</p>", [])).toBe("default");
  });

  it("an image file the page can see is added from the file", () => {
    expect(pasteSource(["Files"], "", [pngFile()])).toBe("files");
  });

  it("plain text next to image-only HTML is the editor's", () => {
    expect(pasteSource(["text/plain", "text/html"], IMG, [])).toBe("default");
  });

  it("an office paste (HTML with text and a picture) stays text", () => {
    expect(pasteSource(["Files", "text/html"], "<p>Hello</p>", [pngFile()])).toBe("default");
  });
});

describe("addImageFiles", () => {
  it("a 41 MB file gives too_large and addImage is not called", async () => {
    editorWith(para("a"));
    const big = pngFile();
    Object.defineProperty(big, "size", { value: 41 * 1024 * 1024 });
    const onProblem = vi.fn();
    await addImageFiles(editor, NOTE, [big], onProblem);
    expect(onProblem).toHaveBeenCalledWith("too_large");
    expect(commands.addImage).not.toHaveBeenCalled();
    expect(types()).toEqual(["paragraph"]);
  });

  it("an SVG gives unsupported", async () => {
    editorWith(para("a"));
    const onProblem = vi.fn();
    await addImageFiles(editor, NOTE, [new File(["<svg/>"], "a.svg", { type: "image/svg+xml" })], onProblem);
    expect(onProblem).toHaveBeenCalledWith("unsupported");
    expect(commands.addImage).not.toHaveBeenCalled();
  });

  it("a PDF gives unsupported without calling addImage", async () => {
    editorWith(para("a"));
    const onProblem = vi.fn();
    await addImageFiles(editor, NOTE, [new File(["%PDF-1.7"], "a.pdf", { type: "application/pdf" })], onProblem);
    expect(onProblem).toHaveBeenCalledWith("unsupported");
    expect(commands.addImage).not.toHaveBeenCalled();
  });

  it("a file with no type (no extension) goes to the core, which reads its bytes", async () => {
    editorWith(para("a"));
    vi.mocked(commands.addImage).mockResolvedValue(info());
    const onProblem = vi.fn();
    const png = new File([new Uint8Array([137, 80, 78, 71])], "pasted", { type: "" });
    await addImageFiles(editor, NOTE, [png], onProblem);
    expect(commands.addImage).toHaveBeenCalledTimes(1);
    expect(Array.from(vi.mocked(commands.addImage).mock.calls[0]![1])).toEqual([137, 80, 78, 71]);
    expect(onProblem).not.toHaveBeenCalled();
    expect(types()).toContain("image");
  });

  it("a PNG calls addImage(noteId, bytes) and inserts a node with the returned id", async () => {
    editorWith(para("a"));
    editor.commands.setTextSelection(2); // end of "a"
    vi.mocked(commands.addImage).mockResolvedValue(info());
    const onProblem = vi.fn();
    await addImageFiles(editor, NOTE, [pngFile("a.png", [1, 2, 3])], onProblem);
    expect(commands.addImage).toHaveBeenCalledTimes(1);
    const [noteId, bytes] = vi.mocked(commands.addImage).mock.calls[0]!;
    expect(noteId).toBe(NOTE);
    expect(Array.from(bytes)).toEqual([1, 2, 3]);
    expect(content()).toEqual([para("a"), img(), para()]);
    expect(onProblem).not.toHaveBeenCalled();
  });

  it("a refusal with code image_too_large gives too_large, and io gives failed", async () => {
    editorWith(para("a"));
    const onProblem = vi.fn();
    vi.mocked(commands.addImage).mockRejectedValueOnce(new CommandError("image_too_large", "x"));
    await addImageFiles(editor, NOTE, [pngFile()], onProblem);
    expect(onProblem).toHaveBeenLastCalledWith("too_large");
    vi.mocked(commands.addImage).mockRejectedValueOnce(new CommandError("io", "x"));
    await addImageFiles(editor, NOTE, [pngFile()], onProblem);
    expect(onProblem).toHaveBeenLastCalledWith("failed");
    expect(types()).toEqual(["paragraph"]);
  });

  it("inserts several files in order, keeps the good ones and reports only the first failure", async () => {
    editorWith(para("a"));
    editor.commands.setTextSelection(2);
    vi.mocked(commands.addImage)
      .mockResolvedValueOnce(info(ID))
      .mockRejectedValueOnce(new CommandError("image_unreadable", "x"))
      .mockResolvedValueOnce(info(ID2));
    const onProblem = vi.fn();
    const svg = new File(["x"], "a.svg", { type: "image/svg+xml" });
    await addImageFiles(editor, NOTE, [pngFile(), pngFile(), svg, pngFile()], onProblem);
    expect(content()).toEqual([para("a"), img(ID), img(ID2), para()]);
    expect(onProblem).toHaveBeenCalledTimes(1);
    expect(onProblem).toHaveBeenCalledWith("failed");
  });

  it("inserts at a dropped position mapped through edits made while it uploads", async () => {
    editorWith(para("one"), para("two"));
    let finish!: (i: ReturnType<typeof info>) => void;
    vi.mocked(commands.addImage).mockReturnValue(new Promise((r) => (finish = r)));
    // Dropped at the end of "one" (position 4).
    const done = addImageFiles(editor, NOTE, [pngFile()], vi.fn(), 4);
    await Promise.resolve();
    // Meanwhile, text is typed at the start of the note.
    editor.view.dispatch(editor.state.tr.insertText("zero ", 1));
    finish(info());
    await done;
    expect(content()).toEqual([para("zero one"), img(), para("two")]);
  });

  it("a two-file drop puts both images in order at the drop point, even when the cursor moves", async () => {
    editorWith(para("one"), para("two"), para("three"));
    const finish: ((i: ReturnType<typeof info>) => void)[] = [];
    vi.mocked(commands.addImage).mockImplementation(() => new Promise((r) => finish.push(r)));
    // Dropped at the end of "one" (position 4); the cursor is elsewhere.
    const done = addImageFiles(editor, NOTE, [pngFile(), pngFile()], vi.fn(), 4);
    await vi.waitFor(() => expect(finish).toHaveLength(1));
    editor.commands.setTextSelection(13); // inside "three"
    finish[0]!(info(ID));
    await vi.waitFor(() => expect(finish).toHaveLength(2));
    // Meanwhile the cursor moves and text is typed far from the drop point.
    editor.commands.setTextSelection(editor.state.doc.content.size - 1);
    editor.commands.insertContent("!");
    finish[1]!(info(ID2));
    await done;
    expect(content()).toEqual([para("one"), img(ID), img(ID2), para("two"), para("three!")]);
  });

  it("inserts nothing once the note became read-only", async () => {
    editorWith(para("a"));
    vi.mocked(commands.addImage).mockResolvedValue(info());
    const pending = addImageFiles(editor, NOTE, [pngFile()], vi.fn());
    editor.setEditable(false);
    await pending;
    expect(types()).toEqual(["paragraph"]);
  });
});

describe("insertImage", () => {
  const insertAt = (pos: number) => {
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, pos)));
    expect(insertImage(editor, info())).not.toBeNull();
    return content();
  };

  it("splits a paragraph at the cursor, so the image is its own block with text above and below", () => {
    editorWith(para("abcd"));
    expect(insertAt(3)).toEqual([para("ab"), img(), para("cd")]);
    // The cursor is on the line below, so typing continues there.
    expect(editor.state.selection.from).toBe(6);
  });

  it("at the start of a line goes above it, at the end below it", () => {
    editorWith(para("ab"), para("cd"));
    expect(insertAt(5)).toEqual([para("ab"), img(), para("cd")]);
    editor.destroy();
    editorWith(para("ab"), para("cd"));
    expect(insertAt(3)).toEqual([para("ab"), img(), para("cd")]);
  });

  it("on an empty line goes above it and keeps the line", () => {
    editorWith(para("ab"), para());
    expect(insertAt(5)).toEqual([para("ab"), img(), para()]);
  });

  it("at the end of the note adds an empty line below to keep writing", () => {
    editorWith(para("ab"));
    expect(insertAt(3)).toEqual([para("ab"), img(), para()]);
  });

  it("never becomes the first child of a list item", () => {
    const item = (...content: JSONContent[]): JSONContent => ({ type: "listItem", content });
    editorWith({ type: "bulletList", content: [item(para("ab"))] });
    // Cursor at the very start of the item's text.
    expect(insertAt(3)).toEqual([{ type: "bulletList", content: [item(para("ab"), img())] }]);
    expect(editor.state.selection).toBeInstanceOf(NodeSelection);
    // A second image goes after the first.
    expect(insertImage(editor, info(ID2))).not.toBeNull();
    expect(content()).toEqual([{ type: "bulletList", content: [item(para("ab"), img(), img(ID2))] }]);
  });

  it("in a checklist item goes after its line", () => {
    const task = (...content: JSONContent[]): JSONContent => ({ type: "taskItem", attrs: { checked: false }, content });
    editorWith({ type: "taskList", content: [task(para("ab"))] });
    expect(insertAt(4)).toEqual([{ type: "taskList", content: [task(para("ab"), img())] }]);
  });

  it("a selected image gets the next one after it", () => {
    editorWith(img(), para("x"));
    editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, 0)));
    expect(insertImage(editor, info(ID2))).not.toBeNull();
    expect(content()).toEqual([img(), img(ID2), para("x")]);
  });

  it("a position between list items finds the nearest place an image may go", () => {
    const item = (...content: JSONContent[]): JSONContent => ({ type: "listItem", content });
    editorWith({ type: "bulletList", content: [item(para("a")), item(para("b"))] });
    // 6 is between the two list items, where only a list item may go.
    expect(insertImage(editor, info(), 6)).not.toBeNull();
    const json = JSON.stringify(editor.getJSON());
    expect(json).toContain(ID);
    expect(() => editor.schema.nodeFromJSON(editor.getJSON()).check()).not.toThrow();
  });

  it("does nothing while the note is read-only", () => {
    editorWith(para("ab"));
    editor.setEditable(false);
    expect(insertImage(editor, info())).toBeNull();
    expect(types()).toEqual(["paragraph"]);
  });
});

describe("pickImage", () => {
  it("inserts the picked image at the selection", async () => {
    editorWith(para("a"));
    editor.commands.setTextSelection(2);
    vi.mocked(commands.pickImage).mockResolvedValue(info());
    await pickImage(editor, NOTE, vi.fn());
    expect(commands.pickImage).toHaveBeenCalledWith(NOTE);
    expect(content()).toEqual([para("a"), img(), para()]);
  });

  it("a cancelled picker inserts nothing", async () => {
    editorWith(para("a"));
    vi.mocked(commands.pickImage).mockResolvedValue(null);
    const onProblem = vi.fn();
    await pickImage(editor, NOTE, onProblem);
    expect(types()).toEqual(["paragraph"]);
    expect(onProblem).not.toHaveBeenCalled();
  });

  it("a refused file shows its message", async () => {
    editorWith(para("a"));
    vi.mocked(commands.pickImage).mockRejectedValue(new CommandError("image_unsupported", "x"));
    const onProblem = vi.fn();
    await pickImage(editor, NOTE, onProblem);
    expect(onProblem).toHaveBeenCalledWith("unsupported");
  });
});
