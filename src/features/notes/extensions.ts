import type { Extensions, JSONContent } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import Link from "@tiptap/extension-link";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import { Placeholder } from "@tiptap/extensions";
import { isSafeLink } from "./links";

/**
 * Link that never keeps a CSS class from pasted HTML, so note text cannot borrow
 * the app's own styles to imitate its interface. The core rejects a class too.
 */
const SafeLink = Link.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      class: { default: null, parseHTML: () => null, renderHTML: () => ({}) },
    };
  },
});

/**
 * Editor extensions. Every node and mark they can produce must be in the
 * allowlist in crates/desknotes-core/src/validation.rs.
 */
export function createExtensions(): Extensions {
  return [
    StarterKit.configure({
      // Would append an empty paragraph on first edit and mark untouched notes as changed.
      trailingNode: false,
      link: false, // replaced by SafeLink below
    }),
    SafeLink.configure({
      openOnClick: false, // links open with Ctrl+click, handled in NoteWindow
      autolink: true,
      linkOnPaste: true,
      defaultProtocol: "https",
      isAllowedUri: (url, ctx) => ctx.defaultValidate(url) && isSafeLink(url),
    }),
    TaskList,
    TaskItem.configure({ nested: true }),
    Placeholder.configure({ placeholder: "Write something…" }),
  ];
}

/**
 * Drop link marks whose href is not safe, keeping the text. The native layer
 * rejects such documents, so removing them here prevents a failed save.
 */
export function sanitizeDoc(node: JSONContent): JSONContent {
  const copy: JSONContent = { ...node };
  if (node.marks) {
    copy.marks = node.marks.filter(
      (m) => m.type !== "link" || isSafeLink(String(m.attrs?.href ?? "")),
    );
    if (copy.marks.length === 0) delete copy.marks;
  }
  if (node.content) copy.content = node.content.map(sanitizeDoc);
  return copy;
}

/** Serialized form used for saving and for detecting real changes. */
export function serializeDoc(doc: JSONContent): string {
  return JSON.stringify(sanitizeDoc(doc));
}
