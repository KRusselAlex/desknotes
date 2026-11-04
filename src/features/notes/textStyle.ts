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
