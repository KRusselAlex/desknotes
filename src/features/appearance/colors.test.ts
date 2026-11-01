import { COLOR_PRESETS, INK, contrastRatio, headerShade } from "./colors";

describe("colour presets", () => {
  it.each(COLOR_PRESETS)("$name keeps ink text readable (WCAG AA)", ({ value }) => {
    expect(contrastRatio(INK, value)).toBeGreaterThanOrEqual(4.5);
  });

  it("are valid #rrggbb values and unique", () => {
    const values = COLOR_PRESETS.map((p) => p.value);
    for (const v of values) expect(v).toMatch(/^#[0-9a-f]{6}$/);
    expect(new Set(values).size).toBe(values.length);
  });

  it("computes known contrast ratios", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrastRatio("#777777", "#777777")).toBeCloseTo(1, 5);
  });

  it("darkens for the header strip", () => {
    expect(headerShade("#ffffff", 0.1)).toBe("#e6e6e6");
  });
});
