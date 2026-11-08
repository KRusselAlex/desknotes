import type { Appearance } from "../../types/note";
import { OPACITY_RANGE } from "../appearance/appearance";

/** Lemon, the colour of a new note: used when the page URL gives none. */
const DEFAULT_COLOR = "#fff4a3";

/**
 * How a note window looks before its note has been read: the colour and opacity the
 * native side put in the page URL (`?color=%23rrggbb&opacity=85`), so a see-through or
 * coloured note does not flash lemon first. Anything else in the URL is ignored.
 */
export function firstFrameLook(search: string): { color: string; appearance: Appearance } {
  const params = new URLSearchParams(search);
  const raw = params.get("color")?.toLowerCase() ?? "";
  const color = /^#[0-9a-f]{6}$/.test(raw) ? raw : DEFAULT_COLOR;
  const opacity = Number(params.get("opacity"));
  const valid =
    Number.isInteger(opacity) &&
    opacity >= OPACITY_RANGE.min &&
    opacity < OPACITY_RANGE.max &&
    opacity % OPACITY_RANGE.step === 0;
  return { color, appearance: valid ? { opacity } : {} };
}
