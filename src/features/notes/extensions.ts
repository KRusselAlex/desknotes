import type { Extensions, JSONContent } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import { isSafeLink } from "./links";

/**
 * Editor extensions. Every node and mark they can produce must be in the
 * allowlist in crates/desknotes-core/src/validation.rs.
 */
export function createExtensions(): Extensions {
  return [
    StarterKit.configure({
      link: {
        openOnClick: false, // links open with Ctrl+click, handled in NoteEditor
        autolink: true,
        linkOnPaste: true,
        defaultProtocol: "https",
        isAllowedUri: (url, ctx) => ctx.defaultValidate(url) && isSafeLink(url),
      },
    }),
    TaskList,
    TaskItem.configure({ nested: true }),
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
