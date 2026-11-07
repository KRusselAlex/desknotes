import { Editor, type JSONContent } from "@tiptap/core";
import fixture from "../../../tests/fixtures/rich-doc.json";
import { setImageUrlResolver } from "../../ipc/images";
import { createExtensions, sanitizeDoc, serializeDoc } from "./extensions";

// jsdom has no native scheme; any address will do.
setImageUrlResolver((id) => `desknotes-image://localhost/${id}`);

function editorWith(content: object) {
  return new Editor({ extensions: createExtensions(), content });
}

describe("editor document format", () => {
  it("round-trips the shared fixture exactly (contract with the Rust validator)", () => {
    const editor = editorWith(fixture);
    expect(editor.getJSON()).toEqual(fixture);
    editor.destroy();
  });

  it("round-trips the image node of the shared fixture", () => {
    const editor = editorWith(fixture);
    const images = editor.getJSON().content!.filter((n) => n.type === "image");
    expect(images).toEqual([{ type: "image", attrs: { id: "a".repeat(64), width: 50 } }]);
    expect(serializeDoc(editor.getJSON())).toContain(`{"type":"image","attrs":{"id":"${"a".repeat(64)}","width":50}}`);
    editor.destroy();
  });

  it("keeps formatting through serialize and reload", () => {
    const first = editorWith(fixture);
    const saved = JSON.stringify(first.getJSON());
    const second = editorWith(JSON.parse(saved));
    expect(second.getJSON()).toEqual(first.getJSON());
    first.destroy();
    second.destroy();
  });

  it("does not create javascript: links from loaded content", () => {
    const editor = editorWith({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "x", marks: [{ type: "link", attrs: { href: "javascript:alert(1)" } }] },
          ],
        },
      ],
    });
    const json = JSON.stringify(sanitizeDoc(editor.getJSON()));
    expect(json).not.toContain("javascript:");
    editor.destroy();
  });

  it("sanitizeDoc removes unsafe links but keeps text and other marks", () => {
    const doc = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "hi",
              marks: [{ type: "bold" }, { type: "link", attrs: { href: "file:///etc/passwd" } }],
            },
            { type: "text", text: "ok", marks: [{ type: "link", attrs: { href: "https://a.b" } }] },
          ],
        },
      ],
    };
    const clean = sanitizeDoc(doc);
    const [first, second] = clean.content![0]!.content!;
    expect(first).toEqual({ type: "text", text: "hi", marks: [{ type: "bold" }] });
    expect(second!.marks).toHaveLength(1);
  });

  it("produces only allowlisted node and mark types for every toolbar action", () => {
    const editor = editorWith({ type: "doc", content: [{ type: "paragraph" }] });
    const chain = () => editor.chain().focus();
    editor.commands.insertContent("word");
    editor.commands.selectAll();
    chain().toggleBold().toggleItalic().toggleUnderline().toggleStrike().run();
    chain().setLink({ href: "https://example.org" }).run();
    chain().toggleHeading({ level: 2 }).run();
    chain().toggleBulletList().run();
    chain().toggleOrderedList().run();
    chain().toggleTaskList().run();

    const allowedNodes = new Set([
      "doc", "paragraph", "text", "heading", "bulletList", "orderedList", "listItem",
      "taskList", "taskItem", "blockquote", "codeBlock", "hardBreak", "horizontalRule", "image",
    ]);
    const allowedMarks = new Set(["bold", "italic", "underline", "strike", "code", "link", "textStyle", "highlight"]);
    const walk = (n: { type?: string; marks?: { type: string }[]; content?: unknown[] }) => {
      expect(allowedNodes).toContain(n.type);
      n.marks?.forEach((m) => expect(allowedMarks).toContain(m.type));
      (n.content as (typeof n)[] | undefined)?.forEach(walk);
    };
    walk(editor.getJSON());
    editor.destroy();
  });
});

describe("no spurious changes", () => {
  it("focusing and clicking an untouched note does not change its document", () => {
    const editor = editorWith(fixture);
    const before = JSON.stringify(editor.getJSON());
    editor.commands.focus("end");
    editor.commands.setTextSelection(1);
    expect(JSON.stringify(editor.getJSON())).toBe(before);
    editor.destroy();
  });
});

describe("pasted links", () => {
  it("drop any CSS class so note text cannot imitate the app", () => {
    const editor = new Editor({
      extensions: createExtensions(),
      content: '<p><a class="dn-popover dn-banner-error" href="https://a.b">x</a></p>',
    });
    const mark = editor.getJSON().content?.[0]?.content?.[0]?.marks?.[0];
    expect(mark?.type).toBe("link");
    expect(mark?.attrs?.class ?? null).toBeNull();
    expect(editor.getHTML()).not.toContain("dn-popover");
    editor.destroy();
  });

  // The core refuses any other target, so one pasted link made the note unsavable.
  it.each(["_self", "_top", "_parent", "", "frame1"])('open in a new window, never target="%s"', (target) => {
    const editor = new Editor({
      extensions: createExtensions(),
      content: `<p><a href="https://a.b" target="${target}">x</a></p>`,
    });
    const saved = JSON.parse(serializeDoc(editor.getJSON())) as JSONContent;
    expect(saved.content?.[0]?.content?.[0]?.marks?.[0]?.attrs?.target).toBe("_blank");
    editor.destroy();
  });
});

describe("sanitizeDoc on link targets", () => {
  it("fixes a target the core would refuse and keeps the link", () => {
    const link = (target: unknown) => ({
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "x", marks: [{ type: "link", attrs: { href: "https://a.b", target } }] }] },
      ],
    });
    const targetOf = (doc: JSONContent) => doc.content?.[0]?.content?.[0]?.marks?.[0]?.attrs?.target;
    expect(targetOf(sanitizeDoc(link("_self")))).toBe("_blank");
    expect(targetOf(sanitizeDoc(link("")))).toBe("_blank");
    expect(targetOf(sanitizeDoc(link(null)))).toBeNull();
    expect(targetOf(sanitizeDoc(link("_blank")))).toBe("_blank");
  });
});

const para = (content: JSONContent[], attrs?: Record<string, unknown>): JSONContent => ({
  type: "doc",
  content: [{ type: "paragraph", ...(attrs ? { attrs } : {}), content }],
});

describe("pasted styles", () => {
  it("drops styles outside the allowed sets and keeps the text", () => {
    const editor = editorWith({ type: "doc", content: [{ type: "paragraph" }] });
    editor.commands.setContent(
      '<p style="text-align:justify"><span style="color:#ff0000;font-size:13.5px;font-family:&quot;x&quot;;font-weight:700">a</span><mark data-color="#123456" style="background-color:#123456">b</mark></p>',
    );
    const saved = serializeDoc(editor.getJSON());
    for (const bad of ["#ff0000", "13.5px", "700", "#123456", "justify"]) expect(saved).not.toContain(bad);
    expect(editor.getText()).toBe("ab");
    editor.destroy();
  });

  it("keeps styles inside the allowed sets", () => {
    const editor = editorWith({ type: "doc", content: [{ type: "paragraph" }] });
    editor.commands.setContent('<p><span style="color:#1d4f91;font-size:18px">a</span></p>');
    const saved = serializeDoc(editor.getJSON());
    expect(saved).toContain('"color":"#1d4f91"');
    expect(saved).toContain('"fontSize":"18px"');
    editor.destroy();
  });

  it("keeps the text of a bare <mark> without a highlight mark", () => {
    const editor = editorWith({ type: "doc", content: [{ type: "paragraph" }] });
    editor.commands.setContent("<p><mark>b</mark></p>");
    expect(editor.getText()).toBe("b");
    expect(serializeDoc(editor.getJSON())).not.toContain("highlight");
    editor.destroy();
  });

  it("refuses a font-family list", () => {
    const editor = editorWith({ type: "doc", content: [{ type: "paragraph" }] });
    editor.commands.setContent('<p><span style="font-family:Arial, sans-serif">a</span></p>');
    expect(serializeDoc(editor.getJSON())).not.toContain("Arial");
    editor.destroy();
  });

  it("copy and paste inside DeskNotes keeps the formatting", () => {
    const original: JSONContent = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          attrs: { textAlign: "center" },
          content: [
            {
              type: "text",
              text: "styled",
              marks: [
                {
                  type: "textStyle",
                  attrs: { fontFamily: "DejaVu Sans", fontSize: "18px", fontWeight: "600", color: "#1d4f91" },
                },
                { type: "highlight", attrs: { color: "#ffe36e" } },
              ],
            },
          ],
        },
      ],
    };
    const editor = editorWith(original);
    expect(editor.getJSON()).toEqual(original);
    const html = editor.getHTML();
    editor.commands.setContent(html);
    expect(editor.getJSON()).toEqual(original);
    editor.destroy();
  });

  it.each(["500", "600"])("a %s weight does not turn into the bold mark on paste", (weight) => {
    const editor = editorWith({ type: "doc", content: [{ type: "paragraph" }] });
    editor.commands.setContent(`<p><span style="font-weight:${weight}">a</span></p>`);
    expect(serializeDoc(editor.getJSON())).not.toContain('"bold"');
    expect(serializeDoc(editor.getJSON())).toContain(`"fontWeight":"${weight}"`);
    editor.destroy();
  });

  it("still reads real bold from pasted web text", () => {
    const editor = editorWith({ type: "doc", content: [{ type: "paragraph" }] });
    editor.commands.setContent('<p><span style="font-weight:700">a</span><b>b</b></p>');
    expect(serializeDoc(editor.getJSON())).toContain('"bold"');
    expect(serializeDoc(editor.getJSON())).not.toContain("700");
    editor.destroy();
  });
});

describe("highlight always carries an allowed colour", () => {
  const press = (editor: Editor) =>
    editor.view.dom.dispatchEvent(
      new KeyboardEvent("keydown", { key: "H", code: "KeyH", keyCode: 72, ctrlKey: true, shiftKey: true, bubbles: true }),
    );
  const marksOfFirst = (editor: Editor) => editor.getJSON().content![0]!.content![0]!.marks;
  const yellow = [{ type: "highlight", attrs: { color: "#ffe36e" } }];
  const withWord = () => {
    const editor = editorWith(para([{ type: "text", text: "word" }]));
    editor.commands.selectAll();
    return editor;
  };

  it("Ctrl+Shift+H uses yellow and toggles off", () => {
    const editor = withWord();
    press(editor);
    expect(marksOfFirst(editor)).toEqual(yellow);
    press(editor);
    expect(marksOfFirst(editor)).toBeUndefined();
    editor.destroy();
  });

  it("toggleHighlight() without a colour uses yellow and toggles off", () => {
    const editor = withWord();
    editor.commands.toggleHighlight();
    expect(marksOfFirst(editor)).toEqual(yellow);
    editor.commands.toggleHighlight();
    expect(marksOfFirst(editor)).toBeUndefined();
    editor.destroy();
  });

  it("setHighlight() without a colour uses yellow", () => {
    const editor = withWord();
    editor.commands.setHighlight();
    expect(marksOfFirst(editor)).toEqual(yellow);
    editor.destroy();
  });

  it("keeps a chosen colour and refuses an unknown one", () => {
    const editor = withWord();
    editor.commands.setHighlight({ color: "#CCDBB2" });
    expect(marksOfFirst(editor)).toEqual([{ type: "highlight", attrs: { color: "#ccdbb2" } }]);
    editor.commands.unsetHighlight();
    expect(editor.commands.setHighlight({ color: "#123456" })).toBe(false);
    expect(editor.commands.toggleHighlight({ color: "red" })).toBe(false);
    expect(marksOfFirst(editor)).toBeUndefined();
    editor.destroy();
  });

  it("the ==text== input rule highlights in yellow", () => {
    const editor = editorWith(para([{ type: "text", text: "a ==x=" }]));
    editor.commands.focus("end");
    const { from, to } = editor.state.selection;
    const handled = editor.view.someProp("handleTextInput", (f) => f(editor.view, from, to, "=", () => editor.state.tr));
    expect(handled).toBe(true);
    const nodes = editor.getJSON().content![0]!.content!;
    expect(nodes.find((n: JSONContent) => n.text === "x")?.marks).toEqual(yellow);
    expect(JSON.stringify(editor.getJSON())).not.toContain('"color":null');
    editor.destroy();
  });

  it("the ==text== paste rule highlights in yellow", () => {
    const editor = editorWith({ type: "doc", content: [{ type: "paragraph" }] });
    editor.commands.focus();
    // jsdom has no ClipboardEvent, so send the transaction a paste produces.
    const { tr } = editor.state;
    editor.view.dispatch(tr.insertText("a ==x== b").setMeta("uiEvent", "paste"));
    const nodes = editor.getJSON().content![0]!.content!;
    expect(nodes.find((n: JSONContent) => n.text === "x")?.marks).toEqual(yellow);
    expect(JSON.stringify(editor.getJSON())).not.toContain('"color":null');
    editor.destroy();
  });
});

describe("editor commands for text style", () => {
  it("setters produce only allowed values and unsetting removes the mark", () => {
    const editor = editorWith(para([{ type: "text", text: "word" }]));
    editor.commands.selectAll();
    editor
      .chain()
      .setFontFamily("DejaVu Sans")
      .setFontSize("20px")
      .setFontWeight("500")
      .setColor("#8c491a")
      .setHighlight({ color: "#bcd9ff" })
      .setTextAlign("right")
      .run();
    const json = editor.getJSON().content![0]!;
    expect(json.attrs).toEqual({ textAlign: "right" });
    expect(json.content![0]!.marks).toEqual([
      {
        type: "textStyle",
        attrs: { fontFamily: "DejaVu Sans", fontSize: "20px", fontWeight: "500", color: "#8c491a" },
      },
      { type: "highlight", attrs: { color: "#bcd9ff" } },
    ]);
    editor
      .chain()
      .unsetFontFamily()
      .unsetFontSize()
      .unsetFontWeight()
      .unsetColor()
      .unsetHighlight()
      .unsetTextAlign()
      .run();
    const after = editor.getJSON().content![0]!;
    expect(after.content![0]!.marks).toBeUndefined();
    expect(after.attrs?.textAlign ?? null).toBeNull();
    editor.destroy();
  });

  it("setTextAlign refuses justify, and Ctrl+Shift+J changes nothing", () => {
    const editor = editorWith(para([{ type: "text", text: "word" }]));
    expect(editor.commands.setTextAlign("justify")).toBe(false);
    editor.view.dom.dispatchEvent(
      new KeyboardEvent("keydown", { key: "J", code: "KeyJ", keyCode: 74, ctrlKey: true, shiftKey: true, bubbles: true }),
    );
    expect(JSON.stringify(editor.getJSON())).not.toContain("justify");
    expect(editor.getJSON().content![0]!.attrs?.textAlign ?? null).toBeNull();
    editor.destroy();
  });
});

describe("own font", () => {
  const styled: JSONContent = para([
    { type: "text", text: "x", marks: [{ type: "textStyle", attrs: { fontFamily: "Comic Neue" } }] },
  ]);

  it("falls back to the note's font when it is missing", () => {
    const editor = editorWith(styled);
    const span = editor.view.dom.querySelector("span")!;
    expect(span.getAttribute("style")).toBe('font-family: "Comic Neue", var(--note-font, var(--dn-font));');
    editor.destroy();
  });

  it("round-trips through the rendered HTML", () => {
    const editor = editorWith(styled);
    editor.commands.setContent(editor.getHTML());
    expect(editor.getJSON().content![0]!.content![0]!.marks).toEqual([
      { type: "textStyle", attrs: { fontFamily: "Comic Neue", fontSize: null, fontWeight: null, color: null } },
    ]);
    editor.destroy();
  });

  it("refuses any other list", () => {
    const editor = editorWith({ type: "doc", content: [{ type: "paragraph" }] });
    editor.commands.setContent('<p><span style="font-family: &quot;X&quot;, var(--other)">a</span></p>');
    expect(serializeDoc(editor.getJSON())).not.toContain("fontFamily");
    editor.destroy();
  });
});

describe("alignment shortcuts", () => {
  const key = (editor: Editor, letter: string) =>
    editor.view.dom.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: letter.toUpperCase(),
        code: `Key${letter.toUpperCase()}`,
        keyCode: letter.toUpperCase().charCodeAt(0),
        ctrlKey: true,
        shiftKey: true,
        bubbles: true,
      }),
    );
  const withDir = (dir: string | null, content: JSONContent) =>
    new Editor({
      extensions: createExtensions(),
      content,
      editorProps: dir ? { attributes: { dir } } : {},
    });
  const alignOf = (editor: Editor) => editor.getJSON().content![0]!.attrs?.textAlign ?? null;

  it("choosing the default with the keyboard removes the stored alignment", () => {
    const editor = withDir("ltr", para([{ type: "text", text: "word" }], { textAlign: "center" }));
    key(editor, "l");
    expect(alignOf(editor)).toBeNull();
    key(editor, "r");
    expect(alignOf(editor)).toBe("right");
    key(editor, "e");
    expect(alignOf(editor)).toBe("center");
    editor.destroy();
  });

  it("follows a right-to-left note", () => {
    const editor = withDir("rtl", para([{ type: "text", text: "word" }]));
    key(editor, "l");
    expect(alignOf(editor)).toBe("left");
    key(editor, "r");
    expect(alignOf(editor)).toBeNull();
    editor.destroy();
  });

  it("in Automatic direction follows the paragraph's own direction", () => {
    const editor = withDir("auto", para([{ type: "text", text: "مرحبا" }]));
    key(editor, "r");
    expect(alignOf(editor)).toBeNull();
    key(editor, "l");
    expect(alignOf(editor)).toBe("left");
    editor.destroy();
  });
});

describe("sanitizeDoc on text style", () => {
  const textNode = (marks: { type: string; attrs?: Record<string, unknown> }[]): JSONContent => ({ type: "text", text: "x", marks });
  const marksOf = (doc: JSONContent) => doc.content![0]!.content![0]!.marks;

  it("nulls stray textStyle values and keeps the allowed ones", () => {
    const doc = para([textNode([{ type: "textStyle", attrs: { color: "#ff0000", fontSize: "18px" } }])]);
    expect(marksOf(sanitizeDoc(doc))).toEqual([{ type: "textStyle", attrs: { color: null, fontSize: "18px" } }]);
  });

  it("removes a textStyle mark when every attribute ends up null", () => {
    const doc = para([textNode([{ type: "bold" }, { type: "textStyle", attrs: { color: "#ff0000", fontSize: "13.5px" } }])]);
    expect(marksOf(sanitizeDoc(doc))).toEqual([{ type: "bold" }]);
    const empty = para([textNode([{ type: "textStyle", attrs: { color: null } }])]);
    expect(marksOf(sanitizeDoc(empty))).toBeUndefined();
  });

  it("lower-cases allowed colours", () => {
    const doc = para([textNode([{ type: "textStyle", attrs: { color: "#1D4F91" } }])]);
    expect(marksOf(sanitizeDoc(doc))).toEqual([{ type: "textStyle", attrs: { color: "#1d4f91" } }]);
  });

  it("removes a highlight whose colour is unknown or null, keeping the text", () => {
    for (const attrs of [{ color: "#123456" }, { color: null }, {}, undefined]) {
      const doc = para([textNode([{ type: "highlight", ...(attrs ? { attrs } : {}) }])]);
      expect(sanitizeDoc(doc).content![0]!.content![0]).toEqual({ type: "text", text: "x" });
    }
    const ok = para([textNode([{ type: "highlight", attrs: { color: "#ffc6a5" } }])]);
    expect(marksOf(sanitizeDoc(ok))).toEqual([{ type: "highlight", attrs: { color: "#ffc6a5" } }]);
  });

  it("drops an unknown or null textAlign on paragraphs and headings, and attrs left empty", () => {
    const doc: JSONContent = {
      type: "doc",
      content: [
        { type: "paragraph", attrs: { textAlign: "justify" }, content: [{ type: "text", text: "a" }] },
        { type: "heading", attrs: { level: 2, textAlign: "start" }, content: [{ type: "text", text: "b" }] },
        { type: "paragraph", attrs: { textAlign: "right" }, content: [{ type: "text", text: "c" }] },
        { type: "paragraph", attrs: { textAlign: null }, content: [{ type: "text", text: "d" }] },
        { type: "heading", attrs: { level: 3, textAlign: null }, content: [{ type: "text", text: "e" }] },
        { type: "orderedList", attrs: { start: 1, type: null }, content: [] },
      ],
    };
    const clean = sanitizeDoc(doc).content!;
    expect(clean[0]).not.toHaveProperty("attrs");
    expect(clean[1]!.attrs).toEqual({ level: 2 });
    expect(clean[2]!.attrs).toEqual({ textAlign: "right" });
    expect(clean[3]).not.toHaveProperty("attrs");
    expect(clean[4]!.attrs).toEqual({ level: 3 });
    // Other null attributes are left alone.
    expect(clean[5]!.attrs).toEqual({ start: 1, type: null });
  });
});

describe("old documents", () => {
  it("serialize unchanged after a load", () => {
    // As stored before text style existed: no textAlign anywhere.
    const stored = JSON.stringify({
      type: "doc",
      content: [
        { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Title" }] },
        { type: "paragraph", content: [{ type: "text", marks: [{ type: "bold" }], text: "x" }] },
        {
          type: "bulletList",
          content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "item" }] }] }],
        },
        { type: "paragraph" },
      ],
    });
    const editor = editorWith(JSON.parse(stored));
    expect(serializeDoc(editor.getJSON())).toBe(stored);
    editor.commands.setContent(JSON.parse(stored));
    expect(serializeDoc(editor.getJSON())).toBe(stored);
    editor.destroy();
  });

  it("the shared fixture saves without null textAlign (the editor's own JSON still has it)", () => {
    const editor = editorWith(fixture);
    const saved = serializeDoc(editor.getJSON());
    expect(saved).not.toContain('"textAlign":null');
    expect(saved).toContain('"textAlign":"center"');
    // Saving that form and loading it again gives the same editor document.
    const reloaded = editorWith(JSON.parse(saved));
    expect(reloaded.getJSON()).toEqual(fixture);
    editor.destroy();
    reloaded.destroy();
  });
});

describe("pasted HTML", () => {
  // jsdom has no ClipboardEvent; the paste logic only passes the event on.
  const paste = (editor: Editor, html: string) => editor.view.pasteHTML(html, new Event("paste") as ClipboardEvent);
  const webHtml =
    '<p style="text-align:center"><span style="font-size:16px;font-weight:400;color:rgb(29,79,145);font-family:Arial">x</span></p>';

  it("from the web keeps the text and drops font, size, weight, colour and alignment", () => {
    const editor = editorWith({ type: "doc", content: [{ type: "paragraph" }] });
    paste(editor, webHtml);
    const saved = serializeDoc(editor.getJSON());
    expect(editor.getText()).toBe("x");
    expect(saved).not.toContain("textStyle");
    expect(saved).not.toContain("textAlign");
    editor.destroy();
  });

  it("from the web drops a highlight colour, keeping the text", () => {
    const editor = editorWith({ type: "doc", content: [{ type: "paragraph" }] });
    paste(editor, '<p>a <mark data-color="#ffe36e" style="background-color:#ffe36e">b</mark></p>');
    expect(editor.getText()).toBe("a b");
    expect(serializeDoc(editor.getJSON())).not.toContain("highlight");
    editor.destroy();
  });

  it("copied from DeskNotes (data-pm-slice) keeps the allowed values", () => {
    const editor = editorWith({ type: "doc", content: [{ type: "paragraph" }] });
    paste(editor, webHtml.replace("<p ", '<p data-pm-slice="0 0 []" '));
    const block = editor.getJSON().content![0]!;
    expect(block.attrs).toEqual({ textAlign: "center" });
    expect(block.content![0]!.marks).toEqual([
      { type: "textStyle", attrs: { color: "#1d4f91", fontFamily: "Arial", fontSize: "16px", fontWeight: "400" } },
    ]);
    editor.destroy();
  });

  it("bold from the web still becomes the bold mark", () => {
    const editor = editorWith({ type: "doc", content: [{ type: "paragraph" }] });
    paste(editor, '<p><span style="font-weight:700">b</span> <span style="font-weight:bold">c</span></p>');
    // As saved: the span's empty textStyle mark is dropped by sanitizeDoc.
    const runs = (JSON.parse(serializeDoc(editor.getJSON())) as JSONContent).content![0]!.content!;
    expect(runs.filter((r) => r.text !== " ").map((r) => r.marks)).toEqual([[{ type: "bold" }], [{ type: "bold" }]]);
    editor.destroy();
  });

  it("keeps links, lists and headings from the web", () => {
    const editor = editorWith({ type: "doc", content: [{ type: "paragraph" }] });
    paste(
      editor,
      '<h2 style="color:red">T</h2><ul><li><p><a href="https://a.b" style="font-size:20px">l</a></p></li></ul>',
    );
    const json = editor.getJSON();
    expect(json.content!.map((n) => n.type)).toEqual(["heading", "bulletList"]);
    expect(JSON.stringify(json)).toContain('"href":"https://a.b"');
    expect(serializeDoc(json)).not.toContain("textStyle");
    editor.destroy();
  });

  it("copy and paste between two notes keeps every text style", () => {
    const source = editorWith(fixture);
    source.commands.selectAll();
    const { dom } = source.view.serializeForClipboard(source.state.selection.content());
    const target = editorWith({ type: "doc", content: [{ type: "paragraph" }] });
    paste(target, dom.innerHTML);
    expect(target.getJSON()).toEqual(source.getJSON());
    source.destroy();
    target.destroy();
  });
});
