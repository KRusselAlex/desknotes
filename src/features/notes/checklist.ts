import type { Editor } from "@tiptap/core";
import { closeHistory, isHistoryTransaction } from "@tiptap/pm/history";
import type { Node as PMNode } from "@tiptap/pm/model";
import type { Transaction } from "@tiptap/pm/state";

/**
 * Checklist helpers for the automation rules (DES-42): rule 1 completes a note when the person
 * ticks its last item; rule 2 unticks the checklist in an open note when its repeating reminder
 * goes off. Items are counted in document order, nested ones included.
 */

const TASK_ITEM = "taskItem";

/** Set on the rules' own transactions, so rule 1 never takes them for a tick by the person. */
export const AUTOMATION_META = "desknotesAutomation";

function taskItems(doc: PMNode): { node: PMNode; pos: number }[] {
  const items: { node: PMNode; pos: number }[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name === TASK_ITEM) items.push({ node, pos });
  });
  return items;
}

/** The note has at least one checklist item, and every one is ticked. */
export function allTasksChecked(doc: PMNode): boolean {
  const items = taskItems(doc);
  return items.length > 0 && items.every(({ node }) => node.attrs.checked === true);
}

/**
 * Rule 1's trigger: a change the person made (not an undo or redo, not the rules' own) that ticks
 * an item that was unticked, and leaves every item ticked. Deleting the last unticked item is not
 * a tick. Loading a note makes no transaction at all.
 */
export function isUserTickOfLastItem(tr: Transaction): boolean {
  if (!tr.docChanged || isHistoryTransaction(tr) || tr.getMeta(AUTOMATION_META)) return false;
  if (!allTasksChecked(tr.doc)) return false;
  return taskItems(tr.before).some(({ node, pos }) => {
    if (node.attrs.checked === true) return false;
    // The start of the item's content: it survives a change of the item's attributes, and is
    // reported deleted when the item itself was removed.
    const mapped = tr.mapping.mapResult(pos + 1, 1);
    if (mapped.deleted) return false;
    const after = tr.doc.resolve(mapped.pos).parent;
    return after.type.name === TASK_ITEM && after.attrs.checked === true;
  });
}

/** Sets `checked` on the items at these indices; returns whether anything changed. One undoable step. */
function setChecked(editor: Editor, indices: number[], checked: boolean): boolean {
  const wanted = new Set(indices);
  const { tr } = editor.state;
  taskItems(tr.doc).forEach(({ node, pos }, i) => {
    if (wanted.has(i) && node.attrs.checked !== checked) tr.setNodeMarkup(pos, undefined, { ...node.attrs, checked });
  });
  if (!tr.docChanged) return false;
  // Its own undo step, never merged with typing just before it.
  closeHistory(tr);
  tr.setMeta(AUTOMATION_META, true);
  editor.view.dispatch(tr);
  return true;
}

/**
 * Unticks every item in one transaction that the editor's undo can take back. Returns the indices
 * of the items that were ticked (for {@link retick}); empty, and nothing changed, when none was.
 */
export function untickAll(editor: Editor): number[] {
  const ticked = taskItems(editor.state.doc).flatMap(({ node }, i) => (node.attrs.checked === true ? [i] : []));
  if (ticked.length > 0) setChecked(editor, ticked, false);
  return ticked;
}

/** Ticks again the items {@link untickAll} returned; an index past the end is skipped. */
export function retick(editor: Editor, indices: number[]): void {
  setChecked(editor, indices, true);
}
