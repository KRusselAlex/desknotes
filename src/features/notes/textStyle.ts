import type { Editor } from "@tiptap/core";
import type { Mark, Node as PMNode } from "@tiptap/pm/model";
import type { Appearance } from "../../types/note";
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
  /** Pixels: the start of the selection's own size, else the note's size. */
  fontSize: number;
  fontWeight: FontWeightValue;
  /** Lower-case hex: the own colour at the start of the selection, else the note's colour. */
  color: string;
  /** Own highlight colour at the start of the selection, or null. */
  highlight: string | null;
  align: TextAlignment;
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

/** The runs a selection covers, in order; for a cursor, the marks typed next. */
function selectedRuns(editor: Editor): OwnStyle[] {
  const { state } = editor;
  const { from, to, empty, $from } = state.selection;
  if (empty) return [ownStyle(state.storedMarks ?? $from.marks())];
  const runs: OwnStyle[] = [];
  state.doc.nodesBetween(from, to, (node) => {
    if (node.isText) runs.push(ownStyle(node.marks));
  });
  return runs.length > 0 ? runs : [ownStyle($from.marks())];
}

function noteDirectionAlign(appearance: Appearance): TextAlignment {
  return appearance.direction === "rtl" ? "right" : "left";
}

function noteTextColor(appearance: Appearance): string {
  return (appearance.textColor ?? APPEARANCE_DEFAULTS.textColor).toLowerCase();
}

/** Alignment of the first paragraph or heading the selection touches. */
function startAlign(editor: Editor): unknown {
  const { from, to } = editor.state.selection;
  let align: unknown = null;
  let found = false;
  editor.state.doc.nodesBetween(from, to, (node) => {
    if (found) return false;
    if (node.isTextblock) {
      found = true;
      align = node.attrs.textAlign;
      return false;
    }
    return true;
  });
  return align;
}

export function textStyleState(editor: Editor, appearance: Appearance): TextStyleState {
  const runs = selectedRuns(editor);
  const first = runs[0]!;
  const families = new Set(runs.map((r) => r.fontFamily));
  const weights = new Set(runs.map((r) => r.fontWeight));
  const weight = weights.size === 1 ? [...weights][0] : null;
  return {
    fontFamily: families.size === 1 ? first.fontFamily : null,
    fontSize: first.fontSize ?? appearance.fontSize ?? APPEARANCE_DEFAULTS.fontSize,
    fontWeight: (weight ?? "400") as FontWeightValue,
    color: first.color ?? noteTextColor(appearance),
    highlight: first.highlight,
    align: normalizeAlign(startAlign(editor)) ?? noteDirectionAlign(appearance),
    canUndo: editor.can().undo(),
    canRedo: editor.can().redo(),
    hasSelection: !editor.state.selection.empty,
  };
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
  const edits: { start: number; stop: number; node: PMNode; text: string }[] = [];
  state.doc.nodesBetween(from, end, (node, pos) => {
    if (!node.isText || !node.text) return;
    const start = Math.max(pos, from);
    const stop = Math.min(pos + node.nodeSize, end);
    const old = node.text.slice(start - pos, stop - pos);
    const text = to === "upper" ? old.toLocaleUpperCase() : old.toLocaleLowerCase();
    if (text !== old) edits.push({ start, stop, node, text });
  });
  if (edits.length === 0) return true;
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

/** Choosing the alignment that is the default for the note's direction removes it (spec §3.6). */
export function setAlign(editor: Editor, align: TextAlignment, appearance: Appearance, options?: StyleOptions): void {
  if (align === noteDirectionAlign(appearance)) styleChain(editor, options).unsetTextAlign().run();
  else styleChain(editor, options).setTextAlign(align).run();
}

export function setWeight(editor: Editor, weight: FontWeightValue, options?: StyleOptions): void {
  if (weight === "400") styleChain(editor, options).unsetFontWeight().run();
  else styleChain(editor, options).setFontWeight(weight).run();
}
