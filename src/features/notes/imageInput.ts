import type { Editor } from "@tiptap/core";
import { NodeSelection, Selection, TextSelection, type Transaction } from "@tiptap/pm/state";
import { insertPoint } from "@tiptap/pm/transform";
import { commands } from "../../ipc/commands";
import type { ImageInfo } from "../../types/note";

/** Why an image was not added; each has one message (design §2.5). */
export type ImageProblem = "too_large" | "unsupported" | "failed";

/** Files over this are refused before they are sent (the core checks again). */
export const MAX_IMAGE_INPUT_BYTES = 40 * 1024 * 1024;

const ACCEPTED_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

const PROBLEM_TEXT: Record<ImageProblem, string> = {
  too_large: "That image is too large. Images can be up to 5 MB.",
  unsupported: "DeskNotes can add PNG, JPEG, GIF or WebP images.",
  failed: "That image could not be added.",
};

export function imageProblemText(problem: ImageProblem): string {
  return PROBLEM_TEXT[problem];
}

/** The quick checks made before sending a file; the core decides from the bytes. */
export function checkImageFile(file: File): ImageProblem | null {
  if (file.size > MAX_IMAGE_INPUT_BYTES) return "too_large";
  if (!ACCEPTED_TYPES.has(file.type)) return "unsupported";
  return null;
}

/** The message for a refused add_image or pick_image. */
export function problemOf(error: unknown): ImageProblem {
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
  if (code === "image_too_large") return "too_large";
  if (code === "image_unsupported") return "unsupported";
  return "failed";
}

/** The files of a paste that are images of any kind (an SVG is then refused with its message). */
export function imageFilesIn(files: FileList | readonly File[] | null | undefined): File[] {
  return Array.from(files ?? []).filter((f) => f.type.startsWith("image/"));
}

const LIST_ITEMS = new Set(["listItem", "taskItem"]);

/**
 * Where an image goes for a cursor at `pos`, splitting the line when the cursor is inside it.
 * The image is always its own block: above a line when the cursor is at its start (or the
 * line is empty), below it at its end, between the two halves otherwise. In a list or
 * checklist item it goes after the item's line, never first (an item starts with a line).
 */
function blockPositionAt(tr: Transaction, pos: number): number | null {
  const type = tr.doc.type.schema.nodes.image!;
  const $pos = tr.doc.resolve(pos);
  if (!$pos.parent.isTextblock) {
    const point = insertPoint(tr.doc, pos, type);
    if (point !== null) return point;
    // Between list items, say: use the nearest line instead.
    const near = Selection.near($pos);
    if (near instanceof NodeSelection) return insertPoint(tr.doc, near.to, type);
    return near.$from.parent.isTextblock ? blockPositionAt(tr, near.from) : null;
  }
  const depth = $pos.depth;
  let at: number;
  if (LIST_ITEMS.has($pos.node(depth - 1).type.name)) at = $pos.after(depth);
  else if ($pos.parentOffset === 0) at = $pos.before(depth);
  else if ($pos.parentOffset === $pos.parent.content.size) at = $pos.after(depth);
  else {
    tr.split(pos);
    at = pos + 1;
  }
  return insertPoint(tr.doc, at, type);
}

/**
 * Inserts a stored image at `at` (a position in the current document) or at the selection,
 * as its own block. A text selection is replaced; a selected image gets the new one after it.
 * Afterwards the cursor is on the line below, so typing goes on there; with no line below
 * at the end of the note or a quote, an empty one is added. Does nothing while the note is
 * read-only. One undo step.
 */
export function insertImage(editor: Editor, image: ImageInfo, at?: number): boolean {
  if (editor.isDestroyed || !editor.isEditable) return false;
  const { state } = editor;
  const tr = state.tr;
  let pos: number;
  if (at !== undefined) pos = Math.max(0, Math.min(at, tr.doc.content.size));
  else if (state.selection instanceof NodeSelection) pos = state.selection.to;
  else {
    if (!state.selection.empty) tr.deleteSelection();
    pos = tr.selection.from;
  }
  const blockPos = blockPositionAt(tr, pos);
  if (blockPos === null) return false;
  const node = state.schema.nodes.image!.create({ id: image.id, width: null });
  tr.insert(blockPos, node);
  const after = blockPos + node.nodeSize;
  const $after = tr.doc.resolve(after);
  if (!$after.nodeAfter && !LIST_ITEMS.has($after.parent.type.name)) {
    tr.insert(after, state.schema.nodes.paragraph!.create());
  }
  if (tr.doc.resolve(after).nodeAfter?.isTextblock) tr.setSelection(TextSelection.create(tr.doc, after + 1));
  else tr.setSelection(NodeSelection.create(tr.doc, blockPos));
  editor.view.dispatch(tr.scrollIntoView());
  return true;
}

/**
 * Sends each file to the core and inserts what it stored, in order: at `at` (a drop, mapped
 * through anything typed meanwhile) or at the selection (a paste). Typing is never blocked.
 * Good files are added even when others fail; only the first failure is reported.
 */
export async function addImageFiles(
  editor: Editor,
  noteId: string,
  files: readonly File[],
  onProblem: (problem: ImageProblem) => void,
  at?: number,
): Promise<void> {
  let reported = false;
  const report = (problem: ImageProblem) => {
    if (reported) return;
    reported = true;
    onProblem(problem);
  };
  let target = at;
  const follow = ({ transaction }: { transaction: Transaction }) => {
    if (target !== undefined) target = transaction.mapping.map(target);
  };
  editor.on("transaction", follow);
  try {
    for (const file of files) {
      const problem = checkImageFile(file);
      if (problem) {
        report(problem);
        continue;
      }
      let image: ImageInfo;
      try {
        image = await commands.addImage(noteId, new Uint8Array(await file.arrayBuffer()));
      } catch (e) {
        report(problemOf(e));
        continue;
      }
      editor.off("transaction", follow);
      const inserted = insertImage(editor, image, target);
      editor.on("transaction", follow);
      // The next one goes after it: where the insert left the cursor.
      if (inserted) target = undefined;
    }
  } finally {
    editor.off("transaction", follow);
  }
}

/** The Insert image… button: the core opens the file picker; nothing happens when cancelled. */
export async function pickImage(editor: Editor, noteId: string, onProblem: (problem: ImageProblem) => void) {
  try {
    const image = await commands.pickImage(noteId);
    if (image) insertImage(editor, image);
  } catch (e) {
    onProblem(problemOf(e));
  }
}
