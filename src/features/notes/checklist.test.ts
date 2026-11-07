import { Editor, type JSONContent } from "@tiptap/core";
import type { Transaction } from "@tiptap/pm/state";
import { createExtensions } from "./extensions";
import { allTasksChecked, isUserTickOfLastItem, retick, untickAll } from "./checklist";

const item = (text: string, checked: boolean): JSONContent => ({
  type: "taskItem",
  attrs: { checked },
  content: [{ type: "paragraph", content: [{ type: "text", text }] }],
});
const doc = (...items: JSONContent[]): JSONContent => ({
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text: "Groceries" }] }, { type: "taskList", content: items }],
});

/** An editor that records every transaction it applies. */
function editorWith(content: JSONContent) {
  const seen: Transaction[] = [];
  const editor = new Editor({ extensions: createExtensions(), content });
  editor.on("transaction", ({ transaction }) => seen.push(transaction));
  return { editor, seen };
}

/** What the checkbox does (TaskItem's node view): set `checked` on the n-th item. */
function tick(editor: Editor, n: number, checked = true) {
  const positions: number[] = [];
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name === "taskItem") positions.push(pos);
  });
  const pos = positions[n]!;
  editor
    .chain()
    .command(({ tr }) => {
      tr.setNodeMarkup(pos, undefined, { ...tr.doc.nodeAt(pos)!.attrs, checked });
      return true;
    })
    .run();
}

const checks = (editor: Editor) => {
  const out: boolean[] = [];
  editor.state.doc.descendants((node) => {
    if (node.type.name === "taskItem") out.push(node.attrs.checked as boolean);
  });
  return out;
};

describe("allTasksChecked", () => {
  it("is true only when there is at least one item and every item is ticked", () => {
    const e1 = editorWith(doc(item("milk", true), item("eggs", true))).editor;
    const e2 = editorWith(doc(item("milk", true), item("eggs", false))).editor;
    const e3 = editorWith({ type: "doc", content: [{ type: "paragraph" }] }).editor;
    expect(allTasksChecked(e1.state.doc)).toBe(true);
    expect(allTasksChecked(e2.state.doc)).toBe(false);
    expect(allTasksChecked(e3.state.doc)).toBe(false);
    [e1, e2, e3].forEach((e) => e.destroy());
  });

  it("counts nested items", () => {
    const nested = item("milk", true);
    nested.content!.push({ type: "taskList", content: [item("oat", false)] });
    const { editor } = editorWith(doc(nested));
    expect(allTasksChecked(editor.state.doc)).toBe(false);
    editor.destroy();
  });
});

describe("isUserTickOfLastItem", () => {
  it("is true for the tick that leaves every item ticked, not for an earlier one", () => {
    const { editor, seen } = editorWith(doc(item("milk", false), item("eggs", false)));
    tick(editor, 0);
    expect(isUserTickOfLastItem(seen.at(-1)!)).toBe(false);
    tick(editor, 1);
    expect(isUserTickOfLastItem(seen.at(-1)!)).toBe(true);
    editor.destroy();
  });

  it("is false for undo and redo of that tick", () => {
    const { editor, seen } = editorWith(doc(item("milk", true), item("eggs", false)));
    tick(editor, 1);
    editor.commands.undo();
    expect(isUserTickOfLastItem(seen.at(-1)!)).toBe(false);
    editor.commands.redo();
    expect(checks(editor)).toEqual([true, true]);
    expect(isUserTickOfLastItem(seen.at(-1)!)).toBe(false);
    editor.destroy();
  });

  it("is false when the last unticked item is deleted rather than ticked", () => {
    const { editor, seen } = editorWith(doc(item("milk", true), item("eggs", false)));
    const positions: number[] = [];
    editor.state.doc.descendants((node, pos) => {
      if (node.type.name === "taskItem") positions.push(pos);
    });
    const eggs = positions[1]!;
    editor.commands.command(({ tr }) => {
      tr.delete(eggs, eggs + tr.doc.nodeAt(eggs)!.nodeSize);
      return true;
    });
    expect(checks(editor)).toEqual([true]);
    expect(isUserTickOfLastItem(seen.at(-1)!)).toBe(false);
    editor.destroy();
  });

  it("is false for typing in a fully ticked list and for the rules' own changes", () => {
    const { editor, seen } = editorWith(doc(item("milk", true), item("eggs", true)));
    editor.commands.insertContentAt(14, "x");
    expect(isUserTickOfLastItem(seen.at(-1)!)).toBe(false);
    untickAll(editor);
    retick(editor, [0, 1]);
    expect(checks(editor)).toEqual([true, true]);
    expect(isUserTickOfLastItem(seen.at(-1)!)).toBe(false);
    editor.destroy();
  });
});

describe("untickAll and retick", () => {
  it("unticks every item in one undoable step and returns which were ticked", () => {
    const nested = item("bread", true);
    nested.content!.push({ type: "taskList", content: [item("rye", true)] });
    const { editor, seen } = editorWith(doc(item("milk", true), item("eggs", false), nested));
    const before = seen.length;
    expect(untickAll(editor)).toEqual([0, 2, 3]);
    expect(seen.length - before).toBe(1);
    expect(checks(editor)).toEqual([false, false, false, false]);
    editor.commands.undo();
    expect(checks(editor)).toEqual([true, false, true, true]);
    editor.destroy();
  });

  it("is its own undo step, apart from typing just before it", () => {
    const { editor } = editorWith(doc(item("milk", true)));
    editor.commands.insertContentAt(14, "x");
    untickAll(editor);
    editor.commands.undo();
    expect(checks(editor)).toEqual([true]);
    expect(editor.state.doc.textContent).toContain("xmilk");
    editor.destroy();
  });

  it("does nothing, and makes no step, when nothing is ticked", () => {
    const { editor, seen } = editorWith(doc(item("milk", false)));
    const before = seen.length;
    expect(untickAll(editor)).toEqual([]);
    expect(seen.length).toBe(before);
    editor.destroy();
  });

  it("retick ticks exactly the given items, in one step", () => {
    const { editor, seen } = editorWith(doc(item("milk", false), item("eggs", false), item("bread", false)));
    const before = seen.length;
    retick(editor, [0, 2, 9]);
    expect(checks(editor)).toEqual([true, false, true]);
    expect(seen.length - before).toBe(1);
    editor.destroy();
  });
});
