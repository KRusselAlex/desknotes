import { APPEARANCE_DEFAULTS, TEXT_COLORS, appearanceStyle } from "./appearance";
import { COLOR_PRESETS, INK, contrastRatio, headerShade } from "./colors";

const style = (color: string, a = {}) => appearanceStyle(color, a) as Record<string, string>;

describe("appearanceStyle", () => {
  it("gives the same background and header as before for the defaults", () => {
    for (const p of COLOR_PRESETS) {
      const s = style(p.value);
      expect(s["--note-bg"]).toBe(p.value);
      expect(s["--note-hd"]).toBe(headerShade(p.value));
    }
  });

  it("sets the default text variables when nothing is changed", () => {
    const s = style("#fff4a3");
    expect(s["--note-ink"]).toBe("#201e1d");
    expect(s["--note-font-size"]).toBe("15px");
    expect(s["--note-leading"]).toBe("1.45");
    expect(s["--note-font"]).toBe("var(--dn-font)");
  });

  it("makes the background see-through below 100 %", () => {
    const s = style("#fff4a3", { opacity: 80 });
    expect(s["--note-bg"]).toBe("rgba(255, 244, 163, 0.8)");
    expect(s["--note-hd"]).toBe("rgba(246, 231, 124, 0.8)");
    expect(style("#fff4a3", { opacity: 100 })["--note-bg"]).toBe("#fff4a3");
  });

  it("uses the chosen font, then falls back to the system font", () => {
    expect(style("#fff4a3", { font: "Ubuntu Mono" })["--note-font"]).toBe('"Ubuntu Mono", var(--dn-font)');
  });

  it("applies size, line spacing and text colour", () => {
    const s = style("#fff4a3", { fontSize: 24, lineSpacing: 120, textColor: "#8c491a" });
    expect(s["--note-font-size"]).toBe("24px");
    expect(s["--note-leading"]).toBe("1.2");
    expect(s["--note-ink"]).toBe("#8c491a");
  });

  it("mirrors the native defaults and text colours", () => {
    expect(APPEARANCE_DEFAULTS).toEqual({
      fontSize: 15,
      textColor: "#201e1d",
      lineSpacing: 145,
      direction: "auto",
      opacity: 100,
    });
    expect(TEXT_COLORS).toEqual(["#201e1d", "#8c491a", "#56633f", "#1d4f91"]);
    expect(APPEARANCE_DEFAULTS.textColor).toBe(INK);
  });
});

describe("contrastRatio", () => {
  it("reads well for the default ink on lemon, and is 1 for the same colour", () => {
    expect(contrastRatio("#201e1d", "#fff4a3")).toBeGreaterThan(12);
    expect(contrastRatio("#201e1d", "#201e1d")).toBe(1);
  });
});
