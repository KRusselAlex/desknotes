import { Editor, type JSONContent } from "@tiptap/core";
import fixture from "../../../tests/fixtures/rich-doc.json";
import { createExtensions, sanitizeDoc, serializeDoc } from "./extensions";

function editorWith(content: object) {
  return new Editor({ extensions: createExtensions(), content });
}

describe("editor document format", () => {
  it("round-trips the shared fixture exactly (contract with the Rust validator)", () => {
    const editor = editorWith(fixture);
    expect(editor.getJSON()).toEqual(fixture);
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
      "taskList", "taskItem", "blockquote", "codeBlock", "hardBreak", "horizontalRule",
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

describe("highlight shortcut", () => {
  const press = (editor: Editor) =>
    editor.view.dom.dispatchEvent(
      new KeyboardEvent("keydown", { key: "H", code: "KeyH", keyCode: 72, ctrlKey: true, shiftKey: true, bubbles: true }),
    );

  it("always uses an allowed colour, never null", () => {
    const editor = editorWith(para([{ type: "text", text: "word" }]));
    editor.commands.selectAll();
    press(editor);
    const first = () => editor.getJSON().content![0]!.content![0]!;
    expect(first().marks).toEqual([{ type: "highlight", attrs: { color: "#ffe36e" } }]);
    press(editor);
    expect(first().marks).toBeUndefined();
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

  it("justify shortcut is ignored", () => {
    const editor = editorWith(para([{ type: "text", text: "word" }]));
    expect(editor.commands.setTextAlign("justify")).toBe(false);
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

  it("turns an unknown textAlign into null on paragraphs and headings", () => {
    const doc: JSONContent = {
      type: "doc",
      content: [
        { type: "paragraph", attrs: { textAlign: "justify" }, content: [{ type: "text", text: "a" }] },
        { type: "heading", attrs: { level: 2, textAlign: "start" }, content: [{ type: "text", text: "b" }] },
        { type: "paragraph", attrs: { textAlign: "right" }, content: [{ type: "text", text: "c" }] },
      ],
    };
    const clean = sanitizeDoc(doc).content!;
    expect(clean[0]!.attrs).toEqual({ textAlign: null });
    expect(clean[1]!.attrs).toEqual({ level: 2, textAlign: null });
    expect(clean[2]!.attrs).toEqual({ textAlign: "right" });
  });
});

describe("old documents", () => {
  it("serialize unchanged after a load", () => {
    const old = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "x" }] }] };
    const editor = editorWith(old);
    const first = serializeDoc(editor.getJSON());
    editor.commands.setContent(JSON.parse(first));
    const second = serializeDoc(editor.getJSON());
    expect(second).toBe(first);
    editor.destroy();
  });
});
