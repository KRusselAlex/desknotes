import type { Editor } from "@tiptap/core";
import { Fragment, Slice } from "@tiptap/pm/model";
import { NodeSelection, Selection, TextSelection, type Transaction } from "@tiptap/pm/state";
import { insertPoint } from "@tiptap/pm/transform";
import type { EditorView } from "@tiptap/pm/view";
import { commands } from "../../ipc/commands";
import type { ImageInfo, PastedImage } from "../../types/note";
import { pastedImageId } from "./imageNode";

/** Why an image was not added; each has one message (design §2.5). */
export type ImageProblem = "too_large" | "unsupported" | "failed";

/** Files over this are refused before they are sent (the core checks again). */
export const MAX_IMAGE_INPUT_BYTES = 40 * 1024 * 1024;

const PROBLEM_TEXT: Record<ImageProblem, string> = {
  too_large: "That image is too large. Images can be up to 5 MB.",
  unsupported: "DeskNotes can add PNG, JPEG, GIF or WebP images.",
  failed: "That image could not be added.",
};

export function imageProblemText(problem: ImageProblem): string {
  return PROBLEM_TEXT[problem];
}

/**
 * Whether a file's type allows it to be an image. The type comes from the file's name, not
 * its bytes, so an empty one (no or an unknown extension) may still be a PNG or JPEG.
 */
function mayBeImage(file: File): boolean {
  const type = file.type.toLowerCase();
  return type === "" || type.startsWith("image/");
}

/**
 * The quick checks made before sending a file: its size, and a type that rules it out (a PDF,
 * an SVG). An empty or any other image type is sent; the core decides from the bytes.
 */
export function checkImageFile(file: File): ImageProblem | null {
  if (file.size > MAX_IMAGE_INPUT_BYTES) return "too_large";
  if (!mayBeImage(file) || file.type.toLowerCase() === "image/svg+xml") return "unsupported";
  return null;
}

/** The message for a refused add_image or pick_image. */
export function problemOf(error: unknown): ImageProblem {
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
  if (code === "image_too_large") return "too_large";
  if (code === "image_unsupported") return "unsupported";
  return "failed";
}

/**
 * The files of a paste that may be images: any image type, or none (an SVG is then refused
 * with its message, and an untyped file that is not an image by the core).
 */
export function imageFilesIn(files: FileList | readonly File[] | null | undefined): File[] {
  return Array.from(files ?? []).filter(mayBeImage);
}

/** Elements that only wrap what they hold; any other element is content of its own. */
const WRAPPERS = new Set(["HTML", "HEAD", "BODY", "META", "DIV", "SPAN", "P", "A", "FIGURE", "PICTURE", "SOURCE", "BR"]);

function onlyImages(node: Node): boolean {
  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType === Node.COMMENT_NODE) continue;
    if (child.nodeType === Node.TEXT_NODE) {
      if (child.textContent?.trim()) return false;
      continue;
    }
    if (!(child instanceof Element)) return false;
    if (child.tagName === "IMG") continue;
    if (!WRAPPERS.has(child.tagName) || !onlyImages(child)) return false;
  }
  return true;
}

/**
 * Whether a paste adds its image files rather than its HTML. Word, Excel and LibreOffice put
 * a picture of the copied range next to the HTML, so the files are used only when the HTML
 * is empty or holds nothing but images (a browser's "Copy Image"); wrapper elements, `<meta>`,
 * comments and whitespace do not count. Otherwise the editor pastes the HTML, and the image
 * node drops any foreign `<img>` in it. The HTML is parsed inert: nothing is loaded.
 */
export function shouldPasteFiles(html: string, files: readonly File[]): boolean {
  if (files.length === 0) return false;
  const template = document.createElement("template");
  template.innerHTML = html;
  return onlyImages(template.content);
}

/**
 * Where a paste's content comes from:
 * - "files": image files the page can see (WebView2 gives them; WebKitGTK never does);
 * - "native": nothing usable, no plain text, and HTML that is empty or holds nothing but
 *   images. WebKitGTK shows a screenshot or an image with text as an empty clipboard, and a
 *   browser's "Copy Image" as a lone `<img>`, so Rust reads the system clipboard instead;
 * - "default": the editor pastes it, so text, office HTML and images copied from a note (their
 *   own address or `data-image-id`) stay the editor's.
 */
export function pasteSource(
  types: readonly string[],
  html: string,
  files: readonly File[],
): "files" | "native" | "default" {
  const template = document.createElement("template");
  template.innerHTML = html;
  // An image copied from a note: the editor's own HTML paste keeps it (design §5).
  if (Array.from(template.content.querySelectorAll("img")).some((img) => pastedImageId(img) !== null)) return "default";
  const images = imageFilesIn(files);
  if (images.length > 0) return shouldPasteFiles(html, images) ? "files" : "default";
  if (types.includes("text/plain")) return "default";
  return onlyImages(template.content) ? "native" : "default";
}

/**
 * Settles a paste of images at paste time, as a normal paste would: a text selection is
 * deleted at once (when at least one file may be added), a selected image gets the new ones
 * after it. Returns the position the images go to, which is then followed through any edit
 * made while they upload.
 */
export function pastePoint(view: EditorView, files: readonly File[]): number {
  const { selection } = view.state;
  if (selection instanceof NodeSelection) return selection.to;
  if (!selection.empty && files.some((f) => checkImageFile(f) === null)) {
    view.dispatch(view.state.tr.deleteSelection().scrollIntoView());
  }
  return view.state.selection.from;
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
 * Inserts a stored image as its own block at `at` (a position in the current document: a
 * paste or drop point) or, for the picker, at the selection, replacing a text selection; a
 * selected image gets the new one after it. With no line below at the end of the note or a
 * quote, an empty one is added. The cursor moves to the line below when it was at the place
 * the image goes (or for the picker); a cursor or selection elsewhere stays where it is.
 * Does nothing while the note is read-only. One undo step. Returns the position just after
 * the image, or null when nothing was inserted.
 */
export function insertImage(editor: Editor, image: ImageInfo, at?: number): number | null {
  if (editor.isDestroyed || !editor.isEditable) return null;
  const { state } = editor;
  const tr = state.tr;
  let pos: number;
  let moveCursor = true;
  if (at !== undefined) {
    pos = Math.max(0, Math.min(at, tr.doc.content.size));
    moveCursor = state.selection.empty && state.selection.from === pos;
  } else if (state.selection instanceof NodeSelection) pos = state.selection.to;
  else {
    if (!state.selection.empty) tr.deleteSelection();
    pos = tr.selection.from;
  }
  const blockPos = blockPositionAt(tr, pos);
  if (blockPos === null) return null;
  const node = state.schema.nodes.image!.create({ id: image.id, width: null });
  tr.insert(blockPos, node);
  const after = blockPos + node.nodeSize;
  const $after = tr.doc.resolve(after);
  if (!$after.nodeAfter && !LIST_ITEMS.has($after.parent.type.name)) {
    tr.insert(after, state.schema.nodes.paragraph!.create());
  }
  if (moveCursor) {
    if (tr.doc.resolve(after).nodeAfter?.isTextblock) tr.setSelection(TextSelection.create(tr.doc, after + 1));
    else tr.setSelection(NodeSelection.create(tr.doc, blockPos));
    tr.scrollIntoView();
  }
  editor.view.dispatch(tr);
  return after;
}

/**
 * Sends each file to the core and inserts what it stored, in order, at `at` (the paste or
 * drop point, followed through anything typed meanwhile; each next image goes right after
 * the last one), or at the selection when no point is given. Typing is never blocked.
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
      const after = insertImage(editor, image, target);
      editor.on("transaction", follow);
      // The next one goes right after it, wherever the cursor is by then.
      if (after !== null) target = after;
    }
  } finally {
    editor.off("transaction", follow);
  }
}

/**
 * Inserts clipboard text at `at` as plain text, never as HTML: one line joins the text there,
 * more lines become paragraphs, as the editor's own plain-text paste does. The cursor moves
 * after it when it was at `at`. Does nothing while the note is read-only. Returns the
 * transaction, or null when nothing was inserted.
 */
function insertPlainText(editor: Editor, text: string, at: number): Transaction | null {
  if (editor.isDestroyed || !editor.isEditable || text === "") return null;
  const { state } = editor;
  const { schema } = state;
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const paragraphs = lines.map((line) => schema.nodes.paragraph!.create(null, line ? schema.text(line) : null));
  const pos = Math.max(0, Math.min(at, state.doc.content.size));
  const moveCursor = state.selection.empty && state.selection.from === pos;
  const tr = state.tr.replaceRange(pos, pos, new Slice(Fragment.from(paragraphs), 1, 1));
  if (moveCursor) tr.setSelection(Selection.near(tr.doc.resolve(tr.mapping.map(pos)))).scrollIntoView();
  editor.view.dispatch(tr);
  return tr;
}

/**
 * A paste the page sees no image in: the core reads the system clipboard, stores its image
 * for the note and the editor inserts it at `at` (the paste point, followed through anything
 * typed meanwhile). Without an image the clipboard's text is inserted there instead, so an
 * image-plus-text clipboard never loses the text. A refusal shows its message.
 */
export async function pasteFromClipboard(
  editor: Editor,
  noteId: string,
  onProblem: (problem: ImageProblem) => void,
  at: number,
): Promise<void> {
  let target = at;
  const follow = ({ transaction }: { transaction: Transaction }) => {
    target = transaction.mapping.map(target);
  };
  editor.on("transaction", follow);
  let pasted: PastedImage;
  try {
    pasted = await commands.pasteImage(noteId);
  } catch (e) {
    onProblem(problemOf(e));
    return;
  } finally {
    editor.off("transaction", follow);
  }
  if (pasted.kind === "image") insertImage(editor, pasted.image, target);
  else if (pasted.kind === "text") insertPlainText(editor, pasted.text, target);
}

/**
 * What Rust took from a drop on the note: dropped links go in as plain text where they were
 * dropped (`x`/`y` in CSS pixels), then the stored images in order after them; at the end of
 * the note when that point is not in the text.
 */
export function insertDropped(
  editor: Editor,
  images: readonly ImageInfo[],
  texts: readonly string[],
  x: number,
  y: number,
) {
  if (editor.isDestroyed || (images.length === 0 && texts.length === 0)) return;
  let at: number | undefined;
  try {
    at = editor.view.posAtCoords({ left: x, top: y })?.pos;
  } catch {
    at = undefined; // no layout to measure (a hidden window)
  }
  let target = at ?? editor.state.doc.content.size;
  if (texts.length > 0) {
    const tr = insertPlainText(editor, texts.join("\n"), target);
    if (tr) target = tr.mapping.map(target);
  }
  for (const image of images) {
    const after = insertImage(editor, image, target);
    if (after === null) return;
    target = after;
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
