import {
  FONT_WEIGHTS,
  HIGHLIGHT_COLORS,
  TEXT_STYLE_COLORS,
  isAllowedAlign,
  isAllowedFontFamily,
  isAllowedFontSize,
  isAllowedFontWeight,
  isAllowedHighlight,
  isAllowedTextColor,
  normalizeFontFamily,
  normalizeHighlight,
  normalizeTextColor,
} from "./textStyle";

describe("allowed value sets", () => {
  it("match the spec", () => {
    expect(TEXT_STYLE_COLORS).toEqual(["#201e1d", "#8c491a", "#56633f", "#1d4f91", "#7a1b14", "#5b3a8c"]);
    expect(HIGHLIGHT_COLORS).toEqual(["#ffe36e", "#ffc6a5", "#ccdbb2", "#bcd9ff"]);
    expect(FONT_WEIGHTS).toEqual([
      { value: "300", label: "Light" },
      { value: "400", label: "Regular" },
      { value: "500", label: "Medium" },
      { value: "600", label: "Semibold" },
    ]);
  });
});

describe("isAllowedFontSize", () => {
  it.each(["10px", "11px", "18px", "32px"])("accepts %s", (v) => expect(isAllowedFontSize(v)).toBe(true));
  it.each(["9px", "33px", "15.5px", "015px", "+15px", "18", "18pt", "18PX", "1em", " 18px", "", null, undefined, 18])(
    "refuses %j",
    (v) => expect(isAllowedFontSize(v)).toBe(false),
  );
});

describe("isAllowedFontWeight", () => {
  it.each(["300", "400", "500", "600"])("accepts %s", (v) => expect(isAllowedFontWeight(v)).toBe(true));
  it.each(["200", "700", "bold", "normal", "0600", "", null, 600])("refuses %j", (v) =>
    expect(isAllowedFontWeight(v)).toBe(false),
  );
});

describe("isAllowedTextColor", () => {
  it.each(TEXT_STYLE_COLORS)("accepts %s", (v) => expect(isAllowedTextColor(v)).toBe(true));
  it("is case-insensitive and returns the lower-case form from the normaliser", () => {
    expect(isAllowedTextColor("#1D4F91")).toBe(true);
    expect(normalizeTextColor("#1D4F91")).toBe("#1d4f91");
  });
  it("accepts the rgb() form browsers report for an allowed colour", () => {
    expect(normalizeTextColor("rgb(29, 79, 145)")).toBe("#1d4f91");
    expect(normalizeTextColor("rgb(29,79,145)")).toBe("#1d4f91");
  });
  it.each(["#ff0000", "red", "#1d4f9", "#1d4f9100", "rgb(255, 0, 0)", "rgb(29, 79, 145, 0.5)", "#ffe36e", "", null, 3])(
    "refuses %j",
    (v) => expect(isAllowedTextColor(v)).toBe(false),
  );
});

describe("isAllowedHighlight", () => {
  it.each(HIGHLIGHT_COLORS)("accepts %s", (v) => expect(isAllowedHighlight(v)).toBe(true));
  it("normalises case and rgb()", () => {
    expect(normalizeHighlight("#FFE36E")).toBe("#ffe36e");
    expect(normalizeHighlight("rgb(255, 227, 110)")).toBe("#ffe36e");
  });
  it.each(["#123456", "#201e1d", "yellow", "", null, undefined])("refuses %j", (v) =>
    expect(isAllowedHighlight(v)).toBe(false),
  );
});

describe("isAllowedFontFamily", () => {
  it("accepts a plain name and strips one pair of surrounding quotes", () => {
    expect(isAllowedFontFamily("DejaVu Sans")).toBe(true);
    expect(normalizeFontFamily('"DejaVu Sans"')).toBe("DejaVu Sans");
    expect(normalizeFontFamily("'DejaVu Sans'")).toBe("DejaVu Sans");
    expect(normalizeFontFamily("  DejaVu Sans ")).toBe("DejaVu Sans");
  });
  it("counts characters like the core, not UTF-16 units", () => {
    expect(isAllowedFontFamily("😀".repeat(100))).toBe(true);
    expect(isAllowedFontFamily("😀".repeat(101))).toBe(false);
    expect(isAllowedFontFamily("a".repeat(100))).toBe(true);
    expect(isAllowedFontFamily("a".repeat(101))).toBe(false);
  });
  it.each([
    "",
    "   ",
    '""',
    "Arial, sans-serif",
    '"Arial", "Helvetica"',
    'a"b',
    "a\\b",
    "a;b",
    "a\nb",
    "a\u0000b",
    "x; color: red",
    null,
    undefined,
    12,
  ])("refuses %j", (v) => expect(isAllowedFontFamily(v)).toBe(false));
});

describe("isAllowedAlign", () => {
  it.each(["left", "center", "right"])("accepts %s", (v) => expect(isAllowedAlign(v)).toBe(true));
  it.each(["justify", "start", "end", "Left", "", null, undefined])("refuses %j", (v) =>
    expect(isAllowedAlign(v)).toBe(false),
  );
});
