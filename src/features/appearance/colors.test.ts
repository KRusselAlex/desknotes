import { COLOR_PRESETS, INK, INK_MUTED, contrastRatio, headerShade } from "./colors";

describe("colour presets", () => {
  it.each(COLOR_PRESETS)("$name: ink on body and muted ink on header pass WCAG AA", (p) => {
    expect(contrastRatio(INK, p.value)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(INK_MUTED, p.header)).toBeGreaterThanOrEqual(4.5);
  });

  it("are valid #rrggbb values and unique", () => {
    const values = COLOR_PRESETS.map((p) => p.value);
    for (const v of [...values, ...COLOR_PRESETS.map((p) => p.header)]) {
      expect(v).toMatch(/^#[0-9a-f]{6}$/);
    }
    expect(new Set(values).size).toBe(values.length);
  });

  it("computes known contrast ratios", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrastRatio("#777777", "#777777")).toBeCloseTo(1, 5);
  });

  it("uses designed header shades for presets and computes others", () => {
    expect(headerShade("#FFF4A3")).toBe("#f6e77c");
    expect(headerShade("#ffffff")).toBe("#f3efe8");
    expect(headerShade("#808080", 0.1)).toBe("#737373");
  });
});
