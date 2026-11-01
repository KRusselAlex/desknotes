export interface ColorPreset {
  name: string;
  value: string;
}

/** Ink colour used on every preset. */
export const INK = "#1f2328";

export const COLOR_PRESETS: readonly ColorPreset[] = [
  { name: "Lemon", value: "#fff4a3" },
  { name: "Peach", value: "#ffd8b1" },
  { name: "Rose", value: "#ffd6e0" },
  { name: "Lilac", value: "#e4d7ff" },
  { name: "Sky", value: "#cfe8ff" },
  { name: "Mint", value: "#c8f7c5" },
  { name: "Sand", value: "#efe6d8" },
  { name: "Paper", value: "#ffffff" },
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

/** Slightly darker shade of a note colour, used for the header strip. */
export function headerShade(hex: string, amount = 0.06): string {
  const n = Number.parseInt(hex.slice(1), 16);
  const parts = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) =>
    Math.max(0, Math.round(v * (1 - amount))),
  );
  return `#${parts.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}
