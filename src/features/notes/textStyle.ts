import type { Editor } from "@tiptap/core";
import type { Mark, Node as PMNode } from "@tiptap/pm/model";
import type { Appearance, TextDirection } from "../../types/note";
import { APPEARANCE_DEFAULTS } from "../appearance/appearance";
/**
 * The values a note may carry for text style, highlight and alignment. They mirror
 * `validation.rs` in the core, which refuses anything else; the editor drops other
 * values from pasted text and from stored documents so a note never becomes
 * unsavable. Every `normalize*` returns the canonical form, or null when refused.
 */

export const TEXT_STYLE_COLORS: readonly string[] = [
  "#201e1d",
  "#8c491a",
  "#56633f",
  "#1d4f91",
  "#7a1b14",
  "#5b3a8c",
];

export const HIGHLIGHT_COLORS: readonly string[] = ["#ffe36e", "#ffc6a5", "#ccdbb2", "#bcd9ff"];

export const FONT_WEIGHTS: readonly { value: "300" | "400" | "500" | "600"; label: string }[] = [
  { value: "300", label: "Light" },
  { value: "400", label: "Regular" },
  { value: "500", label: "Medium" },
  { value: "600", label: "Semibold" },
];

export const FONT_SIZE_MIN = 10;
export const FONT_SIZE_MAX = 32;
export const FONT_NAME_MAX_CHARS = 100;

/** The colour the highlight shortcut applies. */
export const DEFAULT_HIGHLIGHT = "#ffe36e";

const ALIGNMENTS = ["left", "center", "right"] as const;

/** `#RRGGBB` in any case or `rgb(r, g, b)` (how a browser reports a colour) → lower-case hex. */
function toHex(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const v = value.trim();
  if (/^#[0-9a-f]{6}$/i.test(v)) return v.toLowerCase();
  const rgb = /^rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/i.exec(v);
  if (!rgb) return null;
  const parts = [rgb[1]!, rgb[2]!, rgb[3]!].map(Number);
  if (parts.some((n) => n > 255)) return null;
  return `#${parts.map((n) => n.toString(16).padStart(2, "0")).join("")}`;
}

export function normalizeTextColor(value: unknown): string | null {
  const hex = toHex(value);
  return hex && TEXT_STYLE_COLORS.includes(hex) ? hex : null;
}

export function normalizeHighlight(value: unknown): string | null {
  const hex = toHex(value);
  return hex && HIGHLIGHT_COLORS.includes(hex) ? hex : null;
}

/**
 * A single font name. Browsers report a family as a quoted name, so one pair of
 * surrounding quotes is removed. A list ("Arial, sans-serif") is refused, as are
 * the characters the core refuses (control characters, `"`, `\` and `;`).
 */
export function normalizeFontFamily(value: unknown): string | null {
  if (typeof value !== "string") return null;
  let name = value.trim();
  const quote = name[0];
  if (name.length >= 2 && (quote === '"' || quote === "'") && name.endsWith(quote)) {
    name = name.slice(1, -1).trim();
  }
  if (name === "" || [...name].length > FONT_NAME_MAX_CHARS) return null;
  if (/[\p{Cc}",\\;]/u.test(name)) return null;
  return name;
}

/** Whole pixels from 10px to 32px, written canonically ("015px" is refused). */
export function normalizeFontSize(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = /^(\d{1,3})px$/.exec(value);
  if (!match) return null;
  const n = Number(match[1]);
  return n >= FONT_SIZE_MIN && n <= FONT_SIZE_MAX && `${n}px` === value ? value : null;
}

export function normalizeFontWeight(value: unknown): string | null {
  return typeof value === "string" && FONT_WEIGHTS.some((w) => w.value === value) ? value : null;
}

export function normalizeAlign(value: unknown): "left" | "center" | "right" | null {
  return ALIGNMENTS.find((a) => a === value) ?? null;
}

export function isAllowedTextColor(v: unknown): v is string {
  return normalizeTextColor(v) !== null;
}

export function isAllowedHighlight(v: unknown): v is string {
  return normalizeHighlight(v) !== null;
}

export function isAllowedFontFamily(v: unknown): v is string {
  return normalizeFontFamily(v) !== null;
}

export function isAllowedFontSize(v: unknown): v is string {
  return normalizeFontSize(v) !== null;
}

export function isAllowedFontWeight(v: unknown): v is string {
  return normalizeFontWeight(v) !== null;
}

export function isAllowedAlign(v: unknown): v is "left" | "center" | "right" {
  return normalizeAlign(v) !== null;
}

export type TextAlignment = "left" | "center" | "right";
export type FontWeightValue = "300" | "400" | "500" | "600";

/** What the Aa popover shows for the current selection (effective values, spec §3). */
export interface TextStyleState {
  /** The selection's own font, or null when it has none or the selection mixes fonts. */
  fontFamily: string | null;
  /**
   * Pixels: the start of the selection's own size, else the size the text is drawn at
   * (the title line and headings are larger than the note's size), shown within 10–32.
   */
  fontSize: number;
  /** The selection's own weight, else the list entry nearest the weight its block is drawn
   * at, or `DRAWN_BOLD` for a bold title line or heading. */
  fontWeight: FontWeightValue | typeof DRAWN_BOLD;
  /** The weight the text has without its own weight: 700 on the title line and headings, else 400. */
  blockWeight: number;
  /** Lower-case hex: the own colour at the start of the selection, else the note's colour. */
  color: string;
  /** Own highlight colour at the start of the selection, or null. */
  highlight: string | null;
  /** Null when the selected blocks are aligned differently. */
  align: TextAlignment | null;
  canUndo: boolean;
  canRedo: boolean;
  /** True when the selection is not a collapsed cursor. */
  hasSelection: boolean;
}

interface OwnStyle {
  fontFamily: string | null;
  fontSize: number | null;
  fontWeight: string | null;
  color: string | null;
  highlight: string | null;
}

/** Own formatting of one run. A textStyle mark whose values are all refused or null counts as none. */
function ownStyle(marks: readonly Mark[]): OwnStyle {
  const textStyle = marks.find((m) => m.type.name === "textStyle")?.attrs ?? {};
  const highlight = marks.find((m) => m.type.name === "highlight")?.attrs ?? {};
  const size = normalizeFontSize(textStyle.fontSize);
  return {
    fontFamily: normalizeFontFamily(textStyle.fontFamily),
    fontSize: size === null ? null : Number.parseInt(size, 10),
    fontWeight: normalizeFontWeight(textStyle.fontWeight),
    color: normalizeTextColor(textStyle.color),
    highlight: normalizeHighlight(highlight.color),
  };
}

/** What the popover needs from the runs a selection covers: the first run's own style, and
 * the fonts and weights seen. For a cursor, the marks typed next. */
interface RunSummary {
  first: OwnStyle;
  families: Set<string | null>;
  weights: Set<string | null>;
}

function summarize(runs: OwnStyle[]): RunSummary {
  return {
    first: runs[0]!,
    families: new Set(runs.map((r) => r.fontFamily)),
    weights: new Set(runs.map((r) => r.fontWeight)),
  };
}

function selectedRuns(editor: Editor): RunSummary {
  const { state } = editor;
  const { from, to, empty, $from } = state.selection;
  if (empty) return summarize([ownStyle(state.storedMarks ?? $from.marks())]);
  let summary: RunSummary | null = null;
  state.doc.nodesBetween(from, to, (node) => {
    // Once both are known to be mixed, nothing more can change what is shown.
    if (summary && summary.families.size > 1 && summary.weights.size > 1) return false;
    if (!node.isText) return true;
    const run = ownStyle(node.marks);
    if (!summary) summary = summarize([run]);
    else {
      summary.families.add(run.fontFamily);
      summary.weights.add(run.fontWeight);
    }
    return false;
  });
  return summary ?? summarize([ownStyle($from.marks())]);
}

/**
 * Letters of the right-to-left scripts written today (Unicode bidi classes R and AL).
 * Only scripts from Unicode 11 or older, so every WebKit we run on knows the names.
 */
const RTL_LETTER =
  /[\p{Script=Hebrew}\p{Script=Arabic}\p{Script=Syriac}\p{Script=Thaana}\p{Script=Nko}\p{Script=Samaritan}\p{Script=Mandaic}\p{Script=Adlam}\p{Script=Hanifi_Rohingya}]/u;
/** A strong character: a letter, or one of the marks LRM, RLM and ALM. */
const STRONG = /[\p{L}\u200E\u200F\u061C]/u;

/**
 * The direction of a paragraph's text by its first strong character, the rule dir="auto"
 * and `unicode-bidi: plaintext` use: a letter of a right-to-left script (Hebrew, Arabic, …)
 * or RLM/ALM → rtl, any other letter or LRM → ltr, none (only digits, spaces or
 * punctuation) → null.
 */
export function firstStrongDirection(text: string): "ltr" | "rtl" | null {
  const ch = STRONG.exec(text)?.[0];
  if (ch === undefined) return null;
  if (ch === "\u200E") return "ltr";
  return ch === "\u200F" || ch === "\u061C" || RTL_LETTER.test(ch) ? "rtl" : "ltr";
}

function noteDirection(appearance: Appearance): TextDirection {
  return appearance.direction ?? APPEARANCE_DEFAULTS.direction;
}

/**
 * The alignment a block has when it stores none: from the note's direction, or in
 * Automatic direction from the block's own text (an Arabic line is drawn right-aligned).
 */
function defaultAlign(block: PMNode | null, appearance: Appearance): TextAlignment {
  const direction = noteDirection(appearance);
  if (direction === "rtl") return "right";
  if (direction === "ltr" || !block) return "left";
  return firstStrongDirection(block.textContent) === "rtl" ? "right" : "left";
}

/** The direction the editor is drawn with (its `dir`, set by NoteWindow from the note's settings). */
export function editorDirection(editor: Editor): TextDirection | undefined {
  const dir = editor.view.dom.getAttribute("dir");
  return dir === "ltr" || dir === "rtl" || dir === "auto" ? dir : undefined;
}

function noteTextColor(appearance: Appearance): string {
  return (appearance.textColor ?? APPEARANCE_DEFAULTS.textColor).toLowerCase();
}

/** The first paragraph or heading the selection touches, and its position. */
function startBlock(editor: Editor): { node: PMNode; pos: number } | null {
  const { from, to } = editor.state.selection;
  let found: { node: PMNode; pos: number } | null = null;
  editor.state.doc.nodesBetween(from, to, (node, pos) => {
    if (found) return false;
    if (node.isTextblock) {
      found = { node, pos };
      return false;
    }
    return true;
  });
  return found;
}

/** Computed style of an element on the page, or null (a detached editor has none). */
function computedStyle(el: Element | null | undefined): CSSStyleDeclaration | null {
  if (!el?.isConnected) return null;
  return el.ownerDocument.defaultView?.getComputedStyle(el) ?? null;
}

function positive(n: number): number | null {
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** The element that draws the text at `pos` (the text's parent, or the block at a block boundary). */
function elementAt(editor: Editor, pos: number): Element | null {
  try {
    const { node, offset } = editor.view.domAtPos(pos, 1);
    const target = node.nodeType === 1 ? (node.childNodes[offset] ?? node) : node;
    return target.nodeType === 1 ? (target as Element) : target.parentElement;
  } catch {
    return null;
  }
}

/**
 * How much larger than the note's size the text at `pos` is drawn (1.2 on the title
 * line, 1.1 on headings), read from the page; null when the page cannot tell. A ratio
 * rather than the pixels themselves, so a note size changed a moment ago is used at once.
 */
function drawnSizeRatio(editor: Editor, pos: number): number | null {
  try {
    const root = positive(Number.parseFloat(computedStyle(editor.view.dom)?.fontSize ?? ""));
    const text = positive(Number.parseFloat(computedStyle(elementAt(editor, pos))?.fontSize ?? ""));
    return root && text ? text / root : null;
  } catch {
    return null;
  }
}

/** The weight a block is drawn at without any own weight (title line and headings: 700). */
function drawnBlockWeight(editor: Editor, block: { pos: number } | null): number | null {
  if (!block) return null;
  try {
    const value = computedStyle(editor.view.nodeDOM(block.pos) as Element | null)?.fontWeight ?? "";
    if (value === "normal") return 400;
    if (value === "bold") return 700;
    return positive(Number.parseInt(value, 10));
  } catch {
    return null;
  }
}

/** The value the Weight list shows for text drawn bold without its own weight (the title
 * line, headings): not one of the four choices, so choosing Semibold there is a change. */
export const DRAWN_BOLD = "700";

function nearestWeight(weight: number): FontWeightValue {
  let best = FONT_WEIGHTS[0]!;
  for (const w of FONT_WEIGHTS) {
    if (Math.abs(Number(w.value) - weight) < Math.abs(Number(best.value) - weight)) best = w;
  }
  return best.value;
}

/**
 * The alignment of the paragraphs and headings a selection touches: their own, else
 * their default. Null when they differ, so no alignment shows as chosen.
 */
function selectionAlign(editor: Editor, appearance: Appearance): TextAlignment | null {
  const { from, to } = editor.state.selection;
  const seen = new Set<TextAlignment>();
  editor.state.doc.nodesBetween(from, to, (node) => {
    if (seen.size > 1) return false;
    if (!node.isTextblock) return true;
    seen.add(normalizeAlign(node.attrs.textAlign) ?? defaultAlign(node, appearance));
    return false;
  });
  if (seen.size === 0) return defaultAlign(null, appearance);
  return seen.size === 1 ? [...seen][0]! : null;
}

export function textStyleState(editor: Editor, appearance: Appearance): TextStyleState {
  const { first, families, weights } = selectedRuns(editor);
  const weight = weights.size === 1 ? [...weights][0] : null;
  const block = startBlock(editor);
  const blockWeight = drawnBlockWeight(editor, block) ?? 400;
  const noteSize = appearance.fontSize ?? APPEARANCE_DEFAULTS.fontSize;
  const drawnSize = Math.round(noteSize * (drawnSizeRatio(editor, editor.state.selection.from) ?? 1));
  return {
    fontFamily: families.size === 1 ? first.fontFamily : null,
    fontSize: first.fontSize ?? Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, drawnSize)),
    fontWeight: (weight ?? (blockWeight >= 650 ? DRAWN_BOLD : nearestWeight(blockWeight))) as FontWeightValue | typeof DRAWN_BOLD,
    blockWeight,
    color: first.color ?? noteTextColor(appearance),
    highlight: first.highlight,
    align: selectionAlign(editor, appearance),
    canUndo: editor.can().undo(),
    canRedo: editor.can().redo(),
    hasSelection: !editor.state.selection.empty,
  };
}

/** Whether `a` and `b` are the same text except where one has σ and the other ς. */
function onlySigmaDiffers(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i] && !("σς".includes(a[i]!) && "σς".includes(b[i]!))) return false;
  }
  return true;
}

/**
 * Turns the selected letters into upper or lower case in the text itself. One
 * transaction (one undo step); each run keeps its marks and the selection keeps
 * covering the changed text even when its length changes (ß → SS).
 */
export function changeCase(editor: Editor, to: "upper" | "lower"): boolean {
  const { state } = editor;
  const { from, to: end, empty } = state.selection;
  if (empty) return false;
  const convert = (t: string) => (to === "upper" ? t.toLocaleUpperCase() : t.toLocaleLowerCase());
  const edits: { start: number; stop: number; node: PMNode; text: string }[] = [];
  state.doc.nodesBetween(from, end, (block, blockPos) => {
    if (!block.isTextblock) return true;
    // Each run is converted on its own, except for one thing only the whole word can
    // decide: whether a Greek capital sigma becomes the final ς. The block is converted
    // as a whole too (one character per position: an image or line break counts as
    // one), and its slice for the run is taken only when it is the run's own result
    // with nothing but σ/ς differing. A conversion that changes lengths anywhere in the
    // block (ß → SS, a dropped accent) can never move letters between runs that way.
    const original = block.textBetween(0, block.content.size, undefined, "\uFFFC");
    const whole = convert(original);
    const sameLength = whole.length === original.length;
    block.forEach((node, offset) => {
      if (!node.isText || !node.text) return;
      const pos = blockPos + 1 + offset;
      const start = Math.max(pos, from);
      const stop = Math.min(pos + node.nodeSize, end);
      if (start >= stop) return;
      const old = node.text.slice(start - pos, stop - pos);
      const own = convert(old);
      const inWord = sameLength ? whole.slice(start - blockPos - 1, stop - blockPos - 1) : own;
      const text = onlySigmaDiffers(inWord, own) ? inWord : own;
      if (text !== old) edits.push({ start, stop, node, text });
    });
    return false;
  });
  // Already in that case: nothing to do, and nothing was done.
  if (edits.length === 0) return false;
  const tr = state.tr;
  for (const { start, stop, node, text } of edits) {
    // Positions are mapped through the edits already made in this transaction.
    tr.replaceWith(tr.mapping.map(start), tr.mapping.map(stop), state.schema.text(text, node.marks));
  }
  // Map the selection itself so a select-all stays a select-all and endpoints stay in inline content.
  tr.setSelection(state.selection.map(tr.doc, tr.mapping));
  editor.view.dispatch(tr);
  return true;
}

/**
 * `focus: false` applies to the editor's selection without moving focus to the text,
 * for a control used from the keyboard that should keep focus (spec §4).
 */
export interface StyleOptions {
  focus?: boolean;
}

/** A command chain that returns focus to the text unless told not to. */
export function styleChain(editor: Editor, { focus = true }: StyleOptions = {}) {
  return focus ? editor.chain().focus() : editor.chain();
}

/** Choosing the note's own text colour removes the selection's colour instead of copying it (spec §3.4). */
export function setTextColor(editor: Editor, color: string, appearance: Appearance, options?: StyleOptions): void {
  if (color.toLowerCase() === noteTextColor(appearance)) styleChain(editor, options).unsetColor().run();
  else styleChain(editor, options).setColor(color).run();
}

const ALIGNABLE = new Set(["paragraph", "heading"]);

/**
 * Aligns every paragraph and heading the selection touches. Choosing a block's default
 * alignment removes its stored value instead (spec §3.6); in Automatic direction each
 * block's default follows its own text, so one choice can store "right" on an English
 * line and nothing on an Arabic one.
 */
export function setAlign(
  editor: Editor,
  align: TextAlignment,
  appearance: Appearance,
  options?: StyleOptions,
): boolean {
  return styleChain(editor, options)
    .command(({ tr }) => {
      for (const { $from, $to } of tr.selection.ranges) {
        tr.doc.nodesBetween($from.pos, $to.pos, (node, pos) => {
          if (!ALIGNABLE.has(node.type.name)) return true;
          const value = align === defaultAlign(node, appearance) ? null : align;
          if (node.attrs.textAlign !== value) tr.setNodeAttribute(pos, "textAlign", value);
          return false;
        });
      }
      return true;
    })
    .run();
}

/**
 * Choosing the weight the text already has without its own (Regular in a body
 * paragraph) removes its own weight; anything else is stored, so Regular on the bold
 * title line makes it regular.
 */
export function setWeight(
  editor: Editor,
  weight: FontWeightValue,
  options?: StyleOptions,
  blockWeight = 400,
): void {
  if (Number(weight) === blockWeight) styleChain(editor, options).unsetFontWeight().run();
  else styleChain(editor, options).setFontWeight(weight).run();
}
