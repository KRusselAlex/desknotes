import { Editor, type JSONContent } from "@tiptap/core";
import { NodeSelection } from "@tiptap/pm/state";
import { setImageUrlResolver } from "../../ipc/images";
import { createExtensions, sanitizeDoc } from "./extensions";
import { resizedWidth } from "./imageNode";

// jsdom has no native scheme; any address will do.
setImageUrlResolver((id) => `desknotes-image://localhost/${id}`);

const ID = "ab".repeat(32);
const image = (attrs: Record<string, unknown>): JSONContent => ({ type: "image", attrs });
const docOf = (...content: JSONContent[]): JSONContent => ({ type: "doc", content });
const para = (text?: string): JSONContent => (text ? { type: "paragraph", content: [{ type: "text", text }] } : { type: "paragraph" });

let editor: Editor;
const editorWith = (content: JSONContent) => {
  editor = new Editor({ extensions: createExtensions(), content });
  return editor;
};
afterEach(() => editor?.destroy());

// jsdom has no ClipboardEvent; the paste logic only passes the event on.
const pasteHTML = (html: string) => editor.view.pasteHTML(html, new Event("paste") as ClipboardEvent);
const imagesIn = (json: JSONContent): JSONContent[] => [
  ...(json.type === "image" ? [json] : []),
  ...(json.content ?? []).flatMap(imagesIn),
];

describe("image node", () => {
  it("round_trips_through_json", () => {
    const node = image({ id: ID, width: 50 });
    editorWith(docOf(para("x"), node));
    expect(editor.getJSON().content![1]).toEqual(node);
    expect(JSON.stringify(sanitizeDoc(editor.getJSON()).content![1])).toBe(JSON.stringify(node));
  });

  it("a full-width image keeps width null", () => {
    editorWith(docOf(image({ id: ID, width: null })));
    expect(editor.getJSON().content![0]).toEqual(image({ id: ID, width: null }));
  });

  it("html_paste_drops_foreign_images", () => {
    editorWith(docOf(para()));
    pasteHTML('<p>x</p><img src="https://example.com/a.png">');
    expect(imagesIn(editor.getJSON())).toEqual([]);
    expect(editor.getText()).toBe("x");
  });

  it("html_paste_drops_an_image_whose_id_is_not_64_hex", () => {
    editorWith(docOf(para()));
    pasteHTML(`<p>x</p><img data-image-id="${ID.toUpperCase()}" src="https://example.com/a.png">`);
    pasteHTML(`<img data-image-id="../${ID}">`);
    expect(imagesIn(editor.getJSON())).toEqual([]);
  });

  it("html_paste_keeps_own_images", () => {
    editorWith(docOf(para()));
    pasteHTML(`<img data-image-id="${ID}">`);
    expect(imagesIn(editor.getJSON())).toEqual([image({ id: ID, width: null })]);
  });

  it("html_paste_recovers_the_id_from_an_own_address_and_keeps_the_width", () => {
    editorWith(docOf(para()));
    pasteHTML(`<p>a</p><img src="desknotes-image://localhost/${ID}" style="width: 40%"><p>b</p>`);
    expect(imagesIn(editor.getJSON())).toEqual([image({ id: ID, width: 40 })]);
  });

  it("a pasted width outside 10–100 is dropped", () => {
    editorWith(docOf(para()));
    pasteHTML(`<img data-image-id="${ID}" style="width: 500%">`);
    expect(imagesIn(editor.getJSON())).toEqual([image({ id: ID, width: null })]);
  });

  it("renders an img with the address, the id and the width, and nothing else", () => {
    editorWith(docOf(image({ id: ID, width: 50 })));
    const host = document.createElement("div");
    host.innerHTML = editor.getHTML();
    const img = host.firstElementChild!;
    expect(host.children).toHaveLength(1);
    expect(img.tagName).toBe("IMG");
    expect(img.getAttributeNames().sort()).toEqual(["data-image-id", "src", "style"]);
    expect(img.getAttribute("src")).toBe(`desknotes-image://localhost/${ID}`);
    expect(img.getAttribute("data-image-id")).toBe(ID);
    expect((img as HTMLElement).style.width).toBe("50%");
  });

  it("sanitize_clamps_bad_width", () => {
    for (const width of [500, "x", 5, 50.5, -1, {}]) {
      const clean = sanitizeDoc(docOf(image({ id: ID, width })));
      expect(clean.content![0]).toEqual(image({ id: ID, width: null }));
    }
    expect(sanitizeDoc(docOf(image({ id: ID, width: 10 }))).content![0]).toEqual(image({ id: ID, width: 10 }));
    expect(sanitizeDoc(docOf(image({ id: ID, width: 100 }))).content![0]).toEqual(image({ id: ID, width: 100 }));
  });

  it("sanitize keeps only id and width", () => {
    const clean = sanitizeDoc(docOf(image({ id: ID, width: 30, src: "https://example.com/a.png", alt: "x" })));
    expect(clean.content![0]).toEqual(image({ id: ID, width: 30 }));
    expect(sanitizeDoc(docOf(image({ id: ID }))).content![0]).toEqual(image({ id: ID, width: null }));
  });
});

describe("removing an image", () => {
  it("Backspace removes a selected image and undo brings it back", () => {
    editorWith(docOf(para("a"), image({ id: ID, width: 40 }), para("b")));
    editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, 3)));
    editor.commands.keyboardShortcut("Backspace");
    expect(imagesIn(editor.getJSON())).toEqual([]);
    editor.commands.undo();
    expect(imagesIn(editor.getJSON())).toEqual([image({ id: ID, width: 40 })]);
  });
});

describe("image node view", () => {
  const view = () => editor.view.dom.querySelector<HTMLElement>(".dn-image")!;

  it("shows the image at its width with four corner handles", () => {
    editorWith(docOf(image({ id: ID, width: 50 })));
    const dom = view();
    expect(dom.style.width).toBe("50%");
    expect(dom.querySelector("img")!.getAttribute("src")).toBe(`desknotes-image://localhost/${ID}`);
    expect(dom.querySelectorAll(".dn-image-handle")).toHaveLength(4);
  });

  it("shows a muted 'Image not found' box when the image does not load", () => {
    editorWith(docOf(image({ id: ID, width: 50 })));
    view().querySelector("img")!.dispatchEvent(new Event("error"));
    expect(view()).toHaveClass("is-missing");
    expect(view()).toHaveTextContent("Image not found");
    // The box does not take the image's width.
    expect(view().style.width).toBe("");
  });

  it("follows a changed width", () => {
    editorWith(docOf(image({ id: ID, width: 50 })));
    editor.view.dispatch(editor.state.tr.setNodeAttribute(0, "width", 30));
    expect(view().style.width).toBe("30%");
  });

  it("dragging a handle commits the width once on release, as one undo step", () => {
    editorWith(docOf(para("a"), image({ id: ID, width: null })));
    editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, 3)));
    const dom = view();
    // jsdom has no layout: the image is 200 px wide in a 200 px column.
    dom.getBoundingClientRect = () => new DOMRect(0, 0, 200, 100);
    Object.defineProperty(dom.parentElement!, "clientWidth", { configurable: true, value: 200 });
    const handle = dom.querySelector<HTMLElement>(".dn-image-handle.is-br")!;
    const changes: number[] = [];
    editor.on("update", () => changes.push(1));

    handle.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, clientX: 200, clientY: 100, button: 0 }));
    window.dispatchEvent(new MouseEvent("pointermove", { clientX: 150, clientY: 80 }));
    window.dispatchEvent(new MouseEvent("pointermove", { clientX: 101, clientY: 80 }));
    expect(dom.style.width).toBe("51%"); // shown while dragging
    expect(changes).toHaveLength(0); // nothing written yet
    window.dispatchEvent(new MouseEvent("pointerup", { clientX: 101, clientY: 80 }));

    expect(changes).toHaveLength(1);
    expect(editor.getJSON().content![1]).toEqual(image({ id: ID, width: 51 }));
    editor.commands.undo();
    expect(editor.getJSON().content![1]).toEqual(image({ id: ID, width: null }));
  });

  it("a left handle grows the image when dragged left", () => {
    editorWith(docOf(image({ id: ID, width: 50 })));
    const dom = view();
    dom.getBoundingClientRect = () => new DOMRect(0, 0, 100, 50);
    Object.defineProperty(dom.parentElement!, "clientWidth", { configurable: true, value: 200 });
    const handle = dom.querySelector<HTMLElement>(".dn-image-handle.is-tl")!;
    handle.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, clientX: 0, clientY: 0, button: 0 }));
    window.dispatchEvent(new MouseEvent("pointermove", { clientX: -40, clientY: 0 }));
    window.dispatchEvent(new MouseEvent("pointerup", { clientX: -40, clientY: 0 }));
    expect(editor.getJSON().content![0]).toEqual(image({ id: ID, width: 70 }));
  });

  it("does not resize while the note is read-only", () => {
    editorWith(docOf(image({ id: ID, width: 50 })));
    editor.setEditable(false);
    const dom = view();
    dom.getBoundingClientRect = () => new DOMRect(0, 0, 100, 50);
    Object.defineProperty(dom.parentElement!, "clientWidth", { configurable: true, value: 200 });
    const handle = dom.querySelector<HTMLElement>(".dn-image-handle.is-br")!;
    handle.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, clientX: 100, clientY: 50, button: 0 }));
    window.dispatchEvent(new MouseEvent("pointermove", { clientX: 10, clientY: 0 }));
    window.dispatchEvent(new MouseEvent("pointerup", { clientX: 10, clientY: 0 }));
    expect(editor.getJSON().content![0]).toEqual(image({ id: ID, width: 50 }));
  });
});

describe("resizedWidth", () => {
  it("is a whole percentage of the column, from 10 to 100", () => {
    expect(resizedWidth(100, 200)).toBe(50);
    expect(resizedWidth(101, 200)).toBe(51); // 50.5 rounds up
    expect(resizedWidth(5, 200)).toBe(10);
    expect(resizedWidth(-30, 200)).toBe(10);
    expect(resizedWidth(400, 200)).toBe(100);
    expect(resizedWidth(100, 0)).toBe(100);
  });
});
