import { Node, type Editor } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { NodeView } from "@tiptap/pm/view";
import { imageIdFromUrl, imageUrl } from "../../ipc/images";

/** An image's width is a whole percentage of the column it sits in, 10 to 100; null is 100. */
export const MIN_IMAGE_WIDTH = 10;
export const MAX_IMAGE_WIDTH = 100;

/** 64 lowercase hex characters: the SHA-256 of a stored image (as the core checks it). */
export function isImageId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

/** The width the core accepts, or null (full width) for anything else. */
export function normalizeImageWidth(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= MIN_IMAGE_WIDTH && value <= MAX_IMAGE_WIDTH
    ? value
    : null;
}

/** A width in pixels as a whole percentage of the column, kept between 10 and 100. */
export function resizedWidth(px: number, columnPx: number): number {
  if (!(columnPx > 0)) return MAX_IMAGE_WIDTH;
  return Math.min(MAX_IMAGE_WIDTH, Math.max(MIN_IMAGE_WIDTH, Math.round((px / columnPx) * 100)));
}

/**
 * The id of a pasted `<img>`: its `data-image-id` (as DeskNotes copies it), or the id in one
 * of DeskNotes' own image addresses. Any other image (a web page's) has none and is dropped,
 * so nothing is ever loaded from elsewhere.
 */
export function pastedImageId(el: HTMLElement): string | null {
  const data = el.getAttribute("data-image-id");
  if (data !== null) return isImageId(data) ? data : null;
  return imageIdFromUrl(el.getAttribute("src") ?? "");
}

function pastedImageWidth(el: HTMLElement): number | null {
  const match = /^(\d+)%$/.exec(el.style.width.trim());
  return match ? normalizeImageWidth(Number(match[1])) : null;
}

type Corner = "tl" | "tr" | "bl" | "br";
const CORNERS: Corner[] = ["tl", "tr", "bl", "br"];

interface Drag {
  startX: number;
  startPx: number;
  column: number;
  /** Left handles grow the image when dragged left. */
  sign: 1 | -1;
  width: number;
  moved: boolean;
}

/**
 * The image at its width, rounded corners; when selected, an outline and four corner handles
 * (note.css). Dragging a handle shows the new width at once and writes it once, on release,
 * so it is one undo step. An image that cannot be loaded shows "Image not found".
 */
class ImageView implements NodeView {
  readonly dom: HTMLElement;
  private readonly img: HTMLImageElement;
  private readonly missingBox: HTMLElement;
  private missing = false;
  private drag: Drag | null = null;

  constructor(
    private node: ProseMirrorNode,
    private readonly editor: Editor,
    private readonly getPos: () => number | undefined,
  ) {
    this.dom = document.createElement("div");
    this.dom.className = "dn-image";
    this.img = document.createElement("img");
    this.img.alt = "";
    this.img.draggable = false;
    this.img.addEventListener("error", this.onError);
    this.img.addEventListener("load", this.onLoad);
    this.missingBox = document.createElement("div");
    this.missingBox.className = "dn-image-missing";
    this.missingBox.textContent = "Image not found";
    this.dom.append(this.img, this.missingBox);
    for (const corner of CORNERS) {
      const handle = document.createElement("span");
      handle.className = `dn-image-handle is-${corner}`;
      handle.setAttribute("aria-hidden", "true");
      handle.addEventListener("pointerdown", (e) => this.startResize(e, corner));
      this.dom.append(handle);
    }
    this.render();
  }

  update(node: ProseMirrorNode): boolean {
    if (node.type !== this.node.type) return false;
    this.node = node;
    this.render();
    return true;
  }

  /** The handles are ours: the editor must not turn a press on one into a selection change. */
  stopEvent(event: Event): boolean {
    return event.target instanceof Element && event.target.classList.contains("dn-image-handle");
  }

  /** Everything inside is drawn here (width while dragging, the missing box), never typed. */
  ignoreMutation(): boolean {
    return true;
  }

  destroy(): void {
    this.stopListening();
  }

  private render() {
    const src = imageUrl(String(this.node.attrs.id));
    if (this.img.getAttribute("src") !== src) {
      this.missing = false;
      this.img.setAttribute("src", src);
    }
    this.dom.classList.toggle("is-missing", this.missing);
    this.img.hidden = this.missing;
    this.missingBox.hidden = !this.missing;
    this.showWidth(this.drag ? this.drag.width : normalizeImageWidth(this.node.attrs.width));
  }

  /** The missing box keeps its own size; a full-width image needs no style. */
  private showWidth(width: number | null) {
    this.dom.style.width = this.missing || width === null ? "" : `${width}%`;
  }

  private readonly onError = () => {
    this.missing = true;
    this.render();
  };

  private readonly onLoad = () => {
    if (!this.missing) return;
    this.missing = false;
    this.render();
  };

  /** The width a percentage is taken of: the content box of the block the image sits in. */
  private columnWidth(): number {
    const parent = this.dom.parentElement;
    if (!parent) return 0;
    const style = getComputedStyle(parent);
    return parent.clientWidth - (parseFloat(style.paddingLeft) || 0) - (parseFloat(style.paddingRight) || 0);
  }

  private startResize(event: PointerEvent, corner: Corner) {
    if (event.button !== 0 || !this.editor.isEditable || this.missing) return;
    event.preventDefault();
    event.stopPropagation();
    const column = this.columnWidth();
    const startPx = this.dom.getBoundingClientRect().width;
    this.drag = {
      startX: event.clientX,
      startPx,
      column,
      sign: corner === "tl" || corner === "bl" ? -1 : 1,
      width: resizedWidth(startPx, column),
      moved: false,
    };
    this.dom.classList.add("is-resizing");
    window.addEventListener("pointermove", this.onMove);
    window.addEventListener("pointerup", this.onUp);
    window.addEventListener("pointercancel", this.onCancel);
  }

  private readonly onMove = (event: PointerEvent) => {
    const drag = this.drag;
    if (!drag) return;
    drag.moved = true;
    drag.width = resizedWidth(drag.startPx + drag.sign * (event.clientX - drag.startX), drag.column);
    this.showWidth(drag.width);
  };

  private readonly onUp = () => {
    const drag = this.drag;
    this.endResize();
    const pos = this.getPos();
    const current = normalizeImageWidth(this.node.attrs.width) ?? MAX_IMAGE_WIDTH;
    if (!drag?.moved || drag.width === current || typeof pos !== "number" || !this.editor.isEditable) return;
    this.editor.view.dispatch(this.editor.state.tr.setNodeAttribute(pos, "width", drag.width));
  };

  private readonly onCancel = () => this.endResize();

  private endResize() {
    this.drag = null;
    this.dom.classList.remove("is-resizing");
    this.stopListening();
    this.render();
  }

  private stopListening() {
    window.removeEventListener("pointermove", this.onMove);
    window.removeEventListener("pointerup", this.onUp);
    window.removeEventListener("pointercancel", this.onCancel);
  }
}

/**
 * A stored image, as its own block: `{"type":"image","attrs":{"id":<64 hex>,"width":<10–100|null>}}`.
 * The node never holds an address; it is built from the id (src/ipc/images.ts). The core
 * allows it in the document, list items, checklist items and quotes, as this schema does.
 */
export const ImageNode = Node.create({
  name: "image",
  group: "block",
  atom: true,
  selectable: true,
  draggable: false,

  addAttributes() {
    return {
      id: { default: null, rendered: false, parseHTML: pastedImageId },
      width: { default: null, rendered: false, parseHTML: pastedImageWidth },
    };
  },

  parseHTML() {
    return [{ tag: "img", getAttrs: (el) => (pastedImageId(el as HTMLElement) ? null : false) }];
  },

  renderHTML({ node }) {
    const id = String(node.attrs.id);
    const width = normalizeImageWidth(node.attrs.width);
    return ["img", { src: imageUrl(id), "data-image-id": id, ...(width === null ? {} : { style: `width: ${width}%` }) }];
  },

  addNodeView() {
    return ({ node, editor, getPos }) => new ImageView(node, editor, getPos);
  },
});
