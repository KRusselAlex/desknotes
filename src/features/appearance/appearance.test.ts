import { APP_APPEARANCE_DEFAULTS, type AppAppearance } from "../../types/note";
import { APPEARANCE_DEFAULTS, TEXT_COLORS, appClasses, appearanceStyle, effectiveAppearance } from "./appearance";
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
    // Solid for what must stay crisp on a see-through note (the checkbox tick).
    expect(s["--note-bg-solid"]).toBe("#fff4a3");
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

const app = (over: Partial<AppAppearance> = {}): AppAppearance => ({ ...APP_APPEARANCE_DEFAULTS, ...over });

describe("effectiveAppearance precedence", () => {
  const custom = app({ defaultSize: 18, defaultFont: "DejaVu Sans" });

  it("keeps the note's own size and font over the app defaults", () => {
    const own = { fontSize: 20, font: "Amiri", textColor: "#1d4f91", opacity: 85 };
    expect(effectiveAppearance(own, custom)).toEqual(own);
  });

  it("fills only what the note leaves unset from the app defaults", () => {
    expect(effectiveAppearance({}, custom)).toEqual({ fontSize: 18, font: "DejaVu Sans" });
    expect(effectiveAppearance({ lineSpacing: 120 }, custom)).toEqual({ lineSpacing: 120, fontSize: 18, font: "DejaVu Sans" });
  });

  it("scales the default size by 0.9 in Compact, unrounded", () => {
    expect(effectiveAppearance({}, app({ layout: "compact", defaultSize: 18 })).fontSize).toBe(16.2); // not 16.200000000000003px in CSS
    expect(effectiveAppearance({}, app({ layout: "compact" })).fontSize).toBe(13.5);
  });

  it("never goes below 10 px in Compact: Default size 10 stays 10", () => {
    expect(effectiveAppearance({}, app({ layout: "compact", defaultSize: 10 })).fontSize).toBe(10);
    expect(effectiveAppearance({}, app({ layout: "compact", defaultSize: 11 })).fontSize).toBe(10);
    expect(effectiveAppearance({}, app({ layout: "compact", defaultSize: 12 })).fontSize).toBe(10.8);
  });

  it("uses a note's own size as is in Compact", () => {
    expect(effectiveAppearance({ fontSize: 20 }, app({ layout: "compact", defaultSize: 18 })).fontSize).toBe(20);
  });

  it("leaves the font to the system font when neither has one", () => {
    const a = effectiveAppearance({}, APP_APPEARANCE_DEFAULTS);
    expect(a.font).toBeUndefined();
    expect(a.fontSize).toBe(15);
    expect(appearanceStyle("#fff4a3", a)).toEqual(appearanceStyle("#fff4a3", {}));
  });

  it("never changes the note's appearance object", () => {
    const own = {};
    effectiveAppearance(own, custom);
    expect(own).toEqual({});
  });
});

describe("appClasses", () => {
  it("covers all four combinations", () => {
    expect(appClasses(app())).toBe("");
    expect(appClasses(app({ highContrast: true }))).toBe(" is-high-contrast");
    expect(appClasses(app({ layout: "compact" }))).toBe(" is-compact");
    expect(appClasses(app({ highContrast: true, layout: "compact" }))).toBe(" is-high-contrast is-compact");
  });
});

describe("contrastRatio", () => {
  it("reads well for the default ink on lemon, and is 1 for the same colour", () => {
    expect(contrastRatio("#201e1d", "#fff4a3")).toBeGreaterThan(12);
    expect(contrastRatio("#201e1d", "#201e1d")).toBe(1);
  });
});
