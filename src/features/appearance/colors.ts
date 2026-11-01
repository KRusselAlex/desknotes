export interface ColorPreset {
  name: string;
  /** Note body colour (stored in the database). */
  value: string;
  /** Darker shade used for the header and formatting bar. */
  header: string;
}

/** Ink used on every note colour (design token --dn-ink). */
export const INK = "#201e1d";
/** Muted ink for the header strip (design token --dn-ink-muted). */
export const INK_MUTED = "#5a534a";

export const COLOR_PRESETS: readonly ColorPreset[] = [
  { name: "Lemon", value: "#fff4a3", header: "#f6e77c" },
  { name: "Peach", value: "#ffd8b1", header: "#f8c690" },
  { name: "Rose", value: "#ffd6e0", header: "#f7c0cf" },
  { name: "Lilac", value: "#e4d7ff", header: "#d4c3fb" },
  { name: "Sky", value: "#cfe8ff", header: "#b9dbfb" },
  { name: "Mint", value: "#c8f7c5", header: "#b0ecac" },
  { name: "Sand", value: "#efe6d8", header: "#e3d6c2" },
  { name: "Paper", value: "#ffffff", header: "#f3efe8" },
];

function channel(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

/** WCAG relative luminance of a #rrggbb colour. */
export function luminance(hex: string): number {
  const n = Number.parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG contrast ratio between two #rrggbb colours (1 to 21). */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** Header shade for a note colour: the designed shade for presets, computed otherwise. */
export function headerShade(hex: string, amount = 0.06): string {
  const preset = COLOR_PRESETS.find((p) => p.value === hex.toLowerCase());
  if (preset) return preset.header;
  const n = Number.parseInt(hex.slice(1), 16);
  const parts = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) =>
    Math.max(0, Math.round(v * (1 - amount))),
  );
  return `#${parts.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}
