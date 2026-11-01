import { Editor } from "@tiptap/core";
import fixture from "../../../tests/fixtures/rich-doc.json";
import { createExtensions, sanitizeDoc } from "./extensions";

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
    const allowedMarks = new Set(["bold", "italic", "underline", "strike", "code", "link"]);
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
});
