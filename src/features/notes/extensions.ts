import { Extension, getStyleProperty, type Extensions, type JSONContent } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import Bold from "@tiptap/extension-bold";
import Link from "@tiptap/extension-link";
import Highlight from "@tiptap/extension-highlight";
import TextAlign from "@tiptap/extension-text-align";
import { Color, FontFamily, FontSize, TextStyle } from "@tiptap/extension-text-style";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import { Placeholder } from "@tiptap/extensions";
import { isSafeLink } from "./links";
import {
  DEFAULT_HIGHLIGHT,
  normalizeAlign,
  normalizeFontFamily,
  normalizeFontSize,
  normalizeFontWeight,
  normalizeHighlight,
  normalizeTextColor,
} from "./textStyle";

/**
 * Link that never keeps a CSS class from pasted HTML, so note text cannot borrow
 * the app's own styles to imitate its interface. The core rejects a class too.
 * Pasted targets (`_self`, `_top`, …) become `_blank`: links always open in the
 * browser, and the core refuses any other target, which made the note unsavable.
 */
const SafeLink = Link.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      class: { default: null, parseHTML: () => null, renderHTML: () => ({}) },
      target: { default: "_blank", parseHTML: () => "_blank" },
    };
  },
});

/**
 * Bold that treats only weights of 700 and up (and `bold`) as bold when pasted. The
 * stock rule also matches 500 and 600, so a note's own "Medium" or "Semibold" text
 * came back from a copy as bold plus a weight. Keeps the stock position in the
 * schema (priority 101, ahead of the other StarterKit marks) so mark order in
 * saved documents does not change.
 */
const NoteBold = Bold.extend({
  priority: 101,
  parseHTML() {
    return [
      { tag: "strong" },
      { tag: "b", getAttrs: (node) => (node as HTMLElement).style.fontWeight !== "normal" && null },
      { style: "font-weight=400", clearMark: (mark) => mark.type.name === this.name },
      { style: "font-weight", getAttrs: (value) => /^(bold(er)?|[7-9]\d{2,})$/.test(value as string) && null },
    ];
  },
});

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    fontWeight: {
      /** Set the font weight: "300", "400", "500" or "600". */
      setFontWeight: (fontWeight: string) => ReturnType;
      unsetFontWeight: () => ReturnType;
    };
  }
}

/** Font weight as a `textStyle` attribute, next to colour, family and size. */
const FontWeight = Extension.create({
  name: "fontWeight",
  addGlobalAttributes() {
    return [
      {
        types: ["textStyle"],
        attributes: {
          fontWeight: {
            default: null,
            parseHTML: (element) =>
              normalizeFontWeight(getStyleProperty(element, "font-weight") ?? element.style.fontWeight),
            renderHTML: (attributes) => {
              const weight = normalizeFontWeight(attributes.fontWeight);
              return weight ? { style: `font-weight: ${weight}` } : {};
            },
          },
        },
      },
    ];
  },
  addCommands() {
    return {
      setFontWeight:
        (fontWeight) =>
        ({ chain }) =>
          chain().setMark("textStyle", { fontWeight }).run(),
      unsetFontWeight:
        () =>
        ({ chain }) =>
          chain().setMark("textStyle", { fontWeight: null }).removeEmptyTextStyle().run(),
    };
  },
});

/**
 * Pasted text carries whatever styles its source had. These wrappers keep only the
 * allowed values, and read a value the way our own output looks after the browser
 * normalised it (quoted family, rgb() colour), so copy and paste inside DeskNotes
 * keeps the formatting while a web page's colours and fonts become plain text.
 */
const NoteColor = Color.extend({
  addGlobalAttributes() {
    return [
      {
        types: ["textStyle"],
        attributes: {
          color: {
            default: null,
            parseHTML: (element) => normalizeTextColor(getStyleProperty(element, "color") ?? element.style.color),
            renderHTML: (attributes) => {
              const color = normalizeTextColor(attributes.color);
              return color ? { style: `color: ${color}` } : {};
            },
          },
        },
      },
    ];
  },
});

const NoteFontFamily = FontFamily.extend({
  addGlobalAttributes() {
    return [
      {
        types: ["textStyle"],
        attributes: {
          fontFamily: {
            default: null,
            parseHTML: (element) =>
              normalizeFontFamily(getStyleProperty(element, "font-family") ?? element.style.fontFamily),
            // Quoted, so a name such as "3270 Nerd Font" is valid CSS.
            renderHTML: (attributes) => {
              const family = normalizeFontFamily(attributes.fontFamily);
              return family ? { style: `font-family: "${family}"` } : {};
            },
          },
        },
      },
    ];
  },
});

const NoteFontSize = FontSize.extend({
  addGlobalAttributes() {
    return [
      {
        types: ["textStyle"],
        attributes: {
          fontSize: {
            default: null,
            parseHTML: (element) =>
              normalizeFontSize(getStyleProperty(element, "font-size") ?? element.style.fontSize),
            renderHTML: (attributes) => {
              const size = normalizeFontSize(attributes.fontSize);
              return size ? { style: `font-size: ${size}` } : {};
            },
          },
        },
      },
    ];
  },
});

function highlightColorOf(element: HTMLElement): string | null {
  return normalizeHighlight(
    element.getAttribute("data-color") ||
      getStyleProperty(element, "background-color") ||
      element.style.backgroundColor,
  );
}

/**
 * Highlight that always carries one of the four colours. A `<mark>` without one is
 * plain text, and the shortcut (Tiptap's own would set no colour, which the core
 * refuses) uses the default yellow.
 */
const NoteHighlight = Highlight.extend({
  addAttributes() {
    return {
      color: {
        default: null,
        parseHTML: highlightColorOf,
        renderHTML: (attributes) => {
          const color = normalizeHighlight(attributes.color);
          return color ? { "data-color": color, style: `background-color: ${color}; color: inherit` } : {};
        },
      },
    };
  },
  parseHTML() {
    return [{ tag: "mark", getAttrs: (node) => (highlightColorOf(node as HTMLElement) ? null : false) }];
  },
  addKeyboardShortcuts() {
    return {
      "Mod-Shift-h": () => this.editor.commands.toggleHighlight({ color: DEFAULT_HIGHLIGHT }),
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
      bold: false, // replaced by NoteBold below
    }),
    NoteBold,
    SafeLink.configure({
      openOnClick: false, // links open with Ctrl+click, handled in NoteWindow
      autolink: true,
      linkOnPaste: true,
      defaultProtocol: "https",
      isAllowedUri: (url, ctx) => ctx.defaultValidate(url) && isSafeLink(url),
    }),
    TextStyle,
    NoteColor,
    NoteFontFamily,
    NoteFontSize,
    FontWeight,
    NoteHighlight.configure({ multicolor: true }),
    // No "justify": the core refuses it, and the shortcut for it does nothing.
    TextAlign.configure({ types: ["heading", "paragraph"], alignments: ["left", "center", "right"], defaultAlignment: null }),
    TaskList,
    TaskItem.configure({ nested: true }),
    Placeholder.configure({ placeholder: "Write something…" }),
  ];
}

const TEXT_STYLE_NORMALIZERS: Record<string, (v: unknown) => string | null> = {
  fontFamily: normalizeFontFamily,
  fontSize: normalizeFontSize,
  fontWeight: normalizeFontWeight,
  color: normalizeTextColor,
};

/** The mark with only allowed values, or null when nothing of it is left. */
function sanitizeMark(m: NonNullable<JSONContent["marks"]>[number]): typeof m | null {
  if (m.type === "link") {
    if (!isSafeLink(String(m.attrs?.href ?? ""))) return null;
    const target: unknown = m.attrs?.target;
    if (target === undefined || target === null || target === "_blank") return m;
    return { ...m, attrs: { ...m.attrs, target: "_blank" } };
  }
  if (m.type === "highlight") {
    const color = normalizeHighlight(m.attrs?.color);
    return color ? { ...m, attrs: { ...m.attrs, color } } : null;
  }
  if (m.type === "textStyle") {
    const attrs: Record<string, unknown> = { ...m.attrs };
    for (const [name, normalize] of Object.entries(TEXT_STYLE_NORMALIZERS)) {
      if (name in attrs) attrs[name] = normalize(attrs[name]);
    }
    return Object.values(attrs).some((v) => v !== null && v !== undefined) ? { ...m, attrs } : null;
  }
  return m;
}

/**
 * Drop link marks whose href is not safe, keeping the text, and give other
 * targets `_blank`. Keep only allowed values in text style, highlight and
 * alignment. The native layer rejects other documents, so fixing them here
 * prevents a failed save, including for content already in an open note.
 */
export function sanitizeDoc(node: JSONContent): JSONContent {
  const copy: JSONContent = { ...node };
  if (node.marks) {
    copy.marks = node.marks.flatMap((m) => sanitizeMark(m) ?? []);
    if (copy.marks.length === 0) delete copy.marks;
  }
  const align: unknown = node.attrs?.textAlign;
  if (align !== undefined && align !== null && normalizeAlign(align) === null) {
    copy.attrs = { ...node.attrs, textAlign: null };
  }
  if (node.content) copy.content = node.content.map(sanitizeDoc);
  return copy;
}

/** Serialized form used for saving and for detecting real changes. */
export function serializeDoc(doc: JSONContent): string {
  return JSON.stringify(sanitizeDoc(doc));
}
