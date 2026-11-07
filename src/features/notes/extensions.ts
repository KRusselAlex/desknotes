import {
  Extension,
  getStyleProperty,
  markInputRule,
  markPasteRule,
  type Extensions,
  type JSONContent,
} from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import Bold from "@tiptap/extension-bold";
import Link from "@tiptap/extension-link";
import Highlight, { inputRegex, pasteRegex } from "@tiptap/extension-highlight";
import TextAlign from "@tiptap/extension-text-align";
import { Color, FontFamily, FontSize, TextStyle } from "@tiptap/extension-text-style";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import { Placeholder } from "@tiptap/extensions";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { ImageNode, normalizeImageWidth } from "./imageNode";
import { isSafeLink } from "./links";
import {
  DEFAULT_HIGHLIGHT,
  editorDirection,
  normalizeAlign,
  normalizeFontFamily,
  normalizeFontSize,
  normalizeFontWeight,
  normalizeHighlight,
  normalizeTextColor,
  setAlign,
  type TextAlignment,
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

/** A CSS font-weight that reads as bold: `bold`, `bolder` or 700 and up. */
const BOLD_WEIGHT = /^(bold(er)?|[7-9]\d{2,})$/;

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
      { style: "font-weight", getAttrs: (value) => BOLD_WEIGHT.test(value as string) && null },
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

/**
 * What follows an own font in the page: the note's font (Note settings, set by
 * NoteWindow as `--note-font`), then the app's, so a font uninstalled later falls back
 * to the note's font (spec §3.1).
 */
const NOTE_FONT_FALLBACK = "var(--note-font, var(--dn-font))";
const NOTE_FONT_FALLBACK_TAIL = /\s*,\s*var\(\s*--note-font\s*,\s*var\(\s*--dn-font\s*\)\s*\)\s*$/;

const NoteFontFamily = FontFamily.extend({
  addGlobalAttributes() {
    return [
      {
        types: ["textStyle"],
        attributes: {
          fontFamily: {
            default: null,
            // Our own output carries the fallback tail; any other list is refused.
            parseHTML: (element) => {
              const value = getStyleProperty(element, "font-family") ?? element.style.fontFamily;
              return normalizeFontFamily(value.replace(NOTE_FONT_FALLBACK_TAIL, ""));
            },
            // Quoted, so a name such as "3270 Nerd Font" is valid CSS.
            renderHTML: (attributes) => {
              const family = normalizeFontFamily(attributes.fontFamily);
              return family ? { style: `font-family: "${family}", ${NOTE_FONT_FALLBACK}` } : {};
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
  // Tiptap's commands and ==text== rules set no colour when none is given, and a
  // highlight without one is refused by the core. No colour means yellow, and a
  // colour outside the four is not stored.
  addCommands() {
    const colorOf = (attributes?: { color?: string }) =>
      attributes?.color === undefined ? DEFAULT_HIGHLIGHT : normalizeHighlight(attributes.color);
    return {
      setHighlight:
        (attributes) =>
        ({ commands }) => {
          const color = colorOf(attributes);
          return color !== null && commands.setMark(this.name, { color });
        },
      toggleHighlight:
        (attributes) =>
        ({ commands }) => {
          const color = colorOf(attributes);
          return color !== null && commands.toggleMark(this.name, { color });
        },
      unsetHighlight:
        () =>
        ({ commands }) =>
          commands.unsetMark(this.name),
    };
  },
  addInputRules() {
    return [markInputRule({ find: inputRegex, type: this.type, getAttributes: () => ({ color: DEFAULT_HIGHLIGHT }) })];
  },
  addPasteRules() {
    return [markPasteRule({ find: pasteRegex, type: this.type, getAttributes: () => ({ color: DEFAULT_HIGHLIGHT }) })];
  },
  addKeyboardShortcuts() {
    return {
      "Mod-Shift-h": () => this.editor.commands.toggleHighlight({ color: DEFAULT_HIGHLIGHT }),
    };
  },
});

/**
 * Alignment whose shortcuts (Ctrl+Shift+L/E/R) follow the popover's rule: choosing a
 * block's default alignment removes the stored value. The default comes from the
 * direction the editor is drawn with. No "justify": the core refuses it, so
 * Ctrl+Shift+J does nothing.
 */
const NoteTextAlign = TextAlign.extend({
  addKeyboardShortcuts() {
    const align = (value: TextAlignment) => () =>
      setAlign(this.editor, value, { direction: editorDirection(this.editor) }, { focus: false });
    return { "Mod-Shift-l": align("left"), "Mod-Shift-e": align("center"), "Mod-Shift-r": align("right") };
  },
});

/** Style properties pasted HTML keeps only when it was copied from DeskNotes. */
const FOREIGN_STYLES = ["font", "font-size", "font-family", "font-weight", "color", "background", "background-color", "text-align"];

/**
 * Pasted HTML from anywhere but DeskNotes keeps its text and structure (links, lists,
 * headings, bold, italic …) but not its font, size, weight, colour, highlight or
 * alignment: a web page's 16 px Arial in its own blue would otherwise be pinned on the
 * note's text. DeskNotes' own copies carry ProseMirror's `data-pm-slice` and keep
 * everything (the allowlist still applies). A bold weight stays, so it becomes the bold
 * mark; on elements other than `<span>` (only spans make a `textStyle`) the weight stays
 * too, so a `<b style="font-weight:normal">` wrapper is still not bold.
 */
export function stripForeignStyles(html: string): string {
  const template = document.createElement("template");
  template.innerHTML = html;
  const content = template.content;
  if (content.querySelector("[data-pm-slice]")) return html;
  for (const el of content.querySelectorAll<HTMLElement>("[style]")) {
    const weight = el.style.getPropertyValue("font-weight").trim();
    const keepWeight = BOLD_WEIGHT.test(weight) || (weight !== "" && el.tagName !== "SPAN");
    for (const name of FOREIGN_STYLES) el.style.removeProperty(name);
    if (keepWeight) el.style.setProperty("font-weight", weight);
    if (el.style.length === 0) el.removeAttribute("style");
  }
  for (const el of content.querySelectorAll("[data-color]")) el.removeAttribute("data-color");
  return template.innerHTML;
}

const PasteStyleFilter = Extension.create({
  name: "pasteStyleFilter",
  addProseMirrorPlugins() {
    return [new Plugin({ key: new PluginKey("pasteStyleFilter"), props: { transformPastedHTML: stripForeignStyles } })];
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
    NoteTextAlign.configure({ types: ["heading", "paragraph"], alignments: ["left", "center", "right"], defaultAlignment: null }),
    PasteStyleFilter,
    TaskList,
    TaskItem.configure({ nested: true }),
    ImageNode,
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
 * targets `_blank`. Keep only allowed values in text style, highlight,
 * alignment and image width. The native layer rejects other documents, so
 * fixing them here prevents a failed save, including for content already in an
 * open note.
 *
 * A `textAlign` that is null (no alignment, which the editor writes on every
 * paragraph and heading) or not allowed is left out, and so is an `attrs` it
 * leaves empty: a note saved before alignment existed serializes exactly as stored.
 */
export function sanitizeDoc(node: JSONContent): JSONContent {
  // An image has exactly an id and a width the core accepts (anything else is full width).
  if (node.type === "image") {
    return { type: "image", attrs: { id: node.attrs?.id, width: normalizeImageWidth(node.attrs?.width) } };
  }
  const copy: JSONContent = { ...node };
  if (node.marks) {
    copy.marks = node.marks.flatMap((m) => sanitizeMark(m) ?? []);
    if (copy.marks.length === 0) delete copy.marks;
  }
  if (node.attrs && "textAlign" in node.attrs && normalizeAlign(node.attrs.textAlign) === null) {
    const attrs: Record<string, unknown> = { ...node.attrs };
    delete attrs.textAlign;
    if (Object.keys(attrs).length > 0) copy.attrs = attrs;
    else delete copy.attrs;
  }
  if (node.content) copy.content = node.content.map(sanitizeDoc);
  return copy;
}

/** Serialized form used for saving and for detecting real changes. */
export function serializeDoc(doc: JSONContent): string {
  return JSON.stringify(sanitizeDoc(doc));
}
