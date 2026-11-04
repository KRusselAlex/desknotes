import type { CSSProperties } from "react";
import type { AppAppearance, Appearance } from "../../types/note";
import { headerShade } from "./colors";

/** What a note looks like when nothing is changed (Rust treats a missing field the same way). */
export const APPEARANCE_DEFAULTS = {
  fontSize: 15,
  textColor: "#201e1d",
  lineSpacing: 145,
  direction: "auto",
  opacity: 100,
} as const;

/** The four text colours of the Note settings design; Rust refuses any other. */
export const TEXT_COLORS = ["#201e1d", "#8c491a", "#56633f", "#1d4f91"] as const;

/** Ranges the native side accepts (`crates/desknotes-core/src/validation.rs`). */
export const FONT_SIZE_RANGE = { min: 10, max: 32 } as const;
export const LINE_SPACING_RANGE = { min: 100, max: 200, step: 5 } as const;
export const OPACITY_RANGE = { min: 80, max: 100, step: 5 } as const;

/** Compact text is the default size times this (token --dn-compact-text-scale): 15 → 13.5. */
export const COMPACT_TEXT_SCALE = 0.9;

/**
 * What a note is drawn with: its own values, with the font and size it leaves
 * unset filled from the app defaults (Settings → Appearance). In Compact the
 * filled size is the default × 0.9, unrounded; a note's own size is used as is.
 * Only for drawing: what is stored for the note is never this.
 */
export function effectiveAppearance(note: Appearance, app: AppAppearance): Appearance {
  const next: Appearance = { ...note };
  if (next.fontSize === undefined) {
    const scale = app.layout === "compact" ? COMPACT_TEXT_SCALE : 1;
    // Hundredths: 18 × 0.9 is 16.2, not 16.200000000000003.
    next.fontSize = Math.round(app.defaultSize * scale * 100) / 100;
  }
  if (next.font === undefined && app.defaultFont) next.font = app.defaultFont;
  return next;
}

/** Classes for a note root from the app look: see `.dn-note.is-high-contrast` and `.is-compact` in note.css. */
export function appClasses(app: AppAppearance): string {
  return `${app.highContrast ? " is-high-contrast" : ""}${app.layout === "compact" ? " is-compact" : ""}`;
}

function withAlpha(hex: string, alpha: number): string {
  const n = Number.parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

/** True when the note window must be see-through (opacity below 100 %). */
export function isSeeThrough(a: Appearance): boolean {
  return (a.opacity ?? APPEARANCE_DEFAULTS.opacity) < 100;
}

/** Class for a note root that has a header: see `.dn-note.is-see-through` in note.css. */
export function seeThroughClass(a: Appearance): string {
  return isSeeThrough(a) ? " is-see-through" : "";
}

/**
 * CSS variables for one note: background and header (see-through below 100 %),
 * text colour, size, line spacing and font. Only the background gets the
 * opacity; text, icons and controls stay opaque.
 */
export function appearanceStyle(color: string, a: Appearance): CSSProperties {
  const opacity = a.opacity ?? APPEARANCE_DEFAULTS.opacity;
  const header = headerShade(color);
  const see = opacity < 100;
  return {
    "--note-bg": see ? withAlpha(color, opacity / 100) : color,
    "--note-hd": see ? withAlpha(header, opacity / 100) : header,
    "--note-ink": a.textColor ?? APPEARANCE_DEFAULTS.textColor,
    "--note-font-size": `${a.fontSize ?? APPEARANCE_DEFAULTS.fontSize}px`,
    "--note-leading": String((a.lineSpacing ?? APPEARANCE_DEFAULTS.lineSpacing) / 100),
    "--note-font": a.font ? `"${a.font}", var(--dn-font)` : "var(--dn-font)",
  } as CSSProperties;
}
