import { Editor } from "@tiptap/core";
import { AllSelection } from "@tiptap/pm/state";
import type { Appearance } from "../../types/note";
import { createExtensions } from "./extensions";
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
  changeCase,
  firstStrongDirection,
  setAlign,
  setTextColor,
  setWeight,
  textStyleState,
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

describe("text-style editor logic", () => {
  const editors: Editor[] = [];
  function editorWith(content: string | object) {
    const editor = new Editor({ extensions: createExtensions(), content });
    editors.push(editor);
    return editor;
  }
  afterEach(() => {
    editors.splice(0).forEach((e) => e.destroy());
  });

  const plain: Appearance = {};
  const run = (text: string, attrs?: Record<string, unknown>) => ({
    type: "text",
    text,
    ...(attrs ? { marks: [{ type: "textStyle", attrs }] } : {}),
  });
  const para = (...content: object[]) => ({ type: "doc", content: [{ type: "paragraph", content }] });
  const firstBlock = (editor: Editor) => editor.getJSON().content![0]!;

  describe("changeCase", () => {
    it("upper case keeps marks per character", () => {
      const editor = editorWith("<p><strong>Ab</strong> c</p>");
      editor.commands.selectAll();
      expect(changeCase(editor, "upper")).toBe(true);
      expect(firstBlock(editor).content).toEqual([
        { type: "text", text: "AB", marks: [{ type: "bold" }] },
        { type: "text", text: " C" },
      ]);
      editor.commands.undo();
      expect(firstBlock(editor).content).toEqual([
        { type: "text", text: "Ab", marks: [{ type: "bold" }] },
        { type: "text", text: " c" },
      ]);
    });

    it("is a single undo step across several runs", () => {
      const editor = editorWith("<p><em>ab</em> <strong>cd</strong> ef</p>");
      editor.commands.selectAll();
      changeCase(editor, "upper");
      editor.commands.undo();
      expect(editor.getText()).toBe("ab cd ef");
    });

    it("lower case of a partial selection", () => {
      const editor = editorWith("<p>HELLO</p>");
      editor.commands.setTextSelection({ from: 2, to: 4 });
      expect(changeCase(editor, "lower")).toBe(true);
      expect(editor.getText()).toBe("HelLO");
    });

    it("text already in that case: returns false and adds no undo step (DES-33)", () => {
      const editor = editorWith("<p>HELLO</p>");
      editor.commands.selectAll();
      expect(changeCase(editor, "upper")).toBe(false);
      expect(editor.can().undo()).toBe(false);
    });

    it("a Greek capital sigma becomes final only at the end of its word, across styled runs (DES-33)", () => {
      // "ΟΔΟΣ" ends a word; the Σ inside "ΣΟΣ" + "ΤΑ" does not, though its run ends there.
      const editor = editorWith("<p><strong>ΟΔΟΣ</strong> <em>ΣΟΣ</em>ΤΑ</p>");
      editor.commands.selectAll();
      changeCase(editor, "lower");
      expect(editor.getText()).toBe("οδος σοστα");
      expect(firstBlock(editor).content).toEqual([
        { type: "text", text: "οδος", marks: [{ type: "bold" }] },
        { type: "text", text: " " },
        { type: "text", text: "σοσ", marks: [{ type: "italic" }] },
        { type: "text", text: "τα" },
      ]);
    });

    it("changeCase with no selection returns false and changes nothing", () => {
      const editor = editorWith("<p>Hello</p>");
      editor.commands.setTextSelection(3);
      const before = editor.getJSON();
      expect(changeCase(editor, "upper")).toBe(false);
      expect(editor.getJSON()).toEqual(before);
      expect(editor.can().undo()).toBe(false);
    });

    it("changeCase handles letters that change length", () => {
      const editor = editorWith("<p>xßyz</p>");
      const selected = () => editor.state.doc.textBetween(editor.state.selection.from, editor.state.selection.to);
      editor.commands.setTextSelection({ from: 2, to: 3 }); // ß
      changeCase(editor, "upper");
      expect(editor.getText()).toBe("xSSyz");
      expect(selected()).toBe("SS");

      const second = editorWith("<p>xßyz</p>");
      second.commands.setTextSelection({ from: 2, to: 4 }); // ßy
      changeCase(second, "upper");
      expect(second.getText()).toBe("xSSYz");
      expect(second.state.doc.textBetween(second.state.selection.from, second.state.selection.to)).toBe("SSY");
    });

    it("keeps a select-all selection a select-all", () => {
      const editor = editorWith("<p>aßc</p><p>x</p>");
      editor.commands.selectAll();
      changeCase(editor, "upper");
      expect(editor.getText({ blockSeparator: "|" })).toBe("ASSC|X");
      expect(editor.state.selection).toBeInstanceOf(AllSelection);
      expect(editor.state.selection.to).toBe(editor.state.doc.content.size);
    });

    it("leaves the selection over the changed part only", () => {
      const editor = editorWith("<p>abcdef</p>");
      editor.commands.setTextSelection({ from: 3, to: 5 });
      changeCase(editor, "upper");
      expect(editor.getText()).toBe("abCDef");
      const { from, to } = editor.state.selection;
      expect(editor.state.doc.textBetween(from, to)).toBe("CD");
    });
  });

  describe("textStyleState", () => {
    it("textStyleState on a mixed selection", () => {
      const editor = editorWith(para(run("one ", { fontFamily: "Amiri" }), run("two")));
      editor.commands.selectAll();
      const state = textStyleState(editor, plain);
      expect(state.fontFamily).toBeNull();
      expect(Number.isFinite(state.fontSize)).toBe(true);
      expect(state.hasSelection).toBe(true);
    });

    it("reports a font and size that the whole selection shares", () => {
      const editor = editorWith(
        para(run("one ", { fontFamily: "Amiri", fontSize: "20px" }), run("two", { fontFamily: "Amiri" })),
      );
      editor.commands.selectAll();
      const state = textStyleState(editor, plain);
      expect(state.fontFamily).toBe("Amiri");
      expect(state.fontSize).toBe(20);
    });

    it("takes the size and colour from the start of the selection", () => {
      const editor = editorWith(para(run("a", { fontSize: "12px", color: "#1d4f91" }), run("b", { fontSize: "28px" })));
      editor.commands.selectAll();
      const state = textStyleState(editor, plain);
      expect(state.fontSize).toBe(12);
      expect(state.color).toBe("#1d4f91");
    });

    it("textStyleState uses the note appearance as default", () => {
      const editor = editorWith("<p>plain</p>");
      editor.commands.selectAll();
      const state = textStyleState(editor, { fontSize: 20, textColor: "#1d4f91", direction: "rtl" });
      expect(state).toMatchObject({
        fontFamily: null,
        fontSize: 20,
        fontWeight: "400",
        color: "#1d4f91",
        highlight: null,
        align: "right",
      });
    });

    it("falls back to the app defaults and normalises the note colour", () => {
      const editor = editorWith("<p>plain</p>");
      expect(textStyleState(editor, {})).toMatchObject({ fontSize: 15, color: "#201e1d", align: "left" });
      expect(textStyleState(editor, { textColor: "#8C491A" }).color).toBe("#8c491a");
    });

    it("treats a textStyle mark with no values as no own formatting", () => {
      const editor = editorWith(para(run("x", {})));
      editor.commands.selectAll();
      expect(textStyleState(editor, { fontSize: 18 })).toMatchObject({
        fontFamily: null,
        fontSize: 18,
        fontWeight: "400",
        color: "#201e1d",
      });
    });

    it("reads weight (400 when mixed), highlight and stored alignment", () => {
      const editor = editorWith({
        type: "doc",
        content: [
          {
            type: "paragraph",
            attrs: { textAlign: "center" },
            content: [
              { type: "text", text: "a", marks: [{ type: "textStyle", attrs: { fontWeight: "600" } }, { type: "highlight", attrs: { color: "#ffc6a5" } }] },
              run("b", { fontWeight: "300" }),
            ],
          },
        ],
      });
      editor.commands.selectAll();
      expect(textStyleState(editor, plain)).toMatchObject({ fontWeight: "400", highlight: "#ffc6a5", align: "center" });
      editor.commands.setTextSelection({ from: 1, to: 2 });
      expect(textStyleState(editor, plain).fontWeight).toBe("600");
    });

    it("describes a cursor from the marks typed next", () => {
      const editor = editorWith(para(run("abc", { fontSize: "24px" })));
      editor.commands.setTextSelection(3);
      expect(textStyleState(editor, plain)).toMatchObject({ fontSize: 24, hasSelection: false });
    });

    it("reports undo and redo availability", () => {
      const editor = editorWith("<p>Hello</p>");
      editor.commands.selectAll();
      expect(textStyleState(editor, plain)).toMatchObject({ canUndo: false, canRedo: false });
      changeCase(editor, "upper");
      expect(textStyleState(editor, plain)).toMatchObject({ canUndo: true, canRedo: false });
      editor.commands.undo();
      expect(textStyleState(editor, plain)).toMatchObject({ canUndo: false, canRedo: true });
    });
  });

  describe("setters", () => {
    it("setTextColor with the note colour removes the own colour", () => {
      const editor = editorWith("<p>text</p>");
      editor.commands.selectAll();
      setTextColor(editor, "#8c491a", { textColor: "#201e1d" });
      expect(textStyleState(editor, { textColor: "#201e1d" }).color).toBe("#8c491a");
      setTextColor(editor, "#201e1d", { textColor: "#201e1d" });
      expect(JSON.stringify(editor.getJSON())).not.toContain("color");
    });

    it("setTextColor stores a colour that differs from the note colour", () => {
      const editor = editorWith("<p>text</p>");
      editor.commands.selectAll();
      setTextColor(editor, "#201e1d", { textColor: "#1d4f91" });
      expect(firstBlock(editor).content![0]!.marks).toEqual([
        { type: "textStyle", attrs: expect.objectContaining({ color: "#201e1d" }) },
      ]);
    });

    it("setAlign to the default removes textAlign", () => {
      const align = (editor: Editor) => firstBlock(editor).attrs?.textAlign ?? null;
      const ltr = editorWith("<p>text</p>");
      setAlign(ltr, "center", { direction: "ltr" });
      expect(align(ltr)).toBe("center");
      setAlign(ltr, "left", { direction: "ltr" });
      expect(align(ltr)).toBeNull();

      const rtl = editorWith("<p>text</p>");
      setAlign(rtl, "left", { direction: "rtl" });
      expect(align(rtl)).toBe("left");
      setAlign(rtl, "right", { direction: "rtl" });
      expect(align(rtl)).toBeNull();
    });

    describe("in Automatic direction each paragraph's default comes from its own direction", () => {
      const auto: Appearance = { direction: "auto" };
      const aligns = (editor: Editor) => editor.getJSON().content!.map((b) => b.attrs?.textAlign ?? null);

      it("an unset Arabic paragraph is right-aligned, an English one left", () => {
        const editor = editorWith("<p>مرحبا</p><p>Hello</p>");
        editor.commands.setTextSelection(2);
        expect(textStyleState(editor, auto).align).toBe("right");
        expect(textStyleState(editor, {}).align).toBe("right"); // Automatic is the default
        editor.commands.setTextSelection(10);
        expect(textStyleState(editor, auto).align).toBe("left");
      });

      it("Align left on an Arabic paragraph stores left; Align right stores nothing", () => {
        const editor = editorWith("<p>مرحبا</p>");
        setAlign(editor, "left", auto);
        expect(aligns(editor)).toEqual(["left"]);
        setAlign(editor, "right", auto);
        expect(aligns(editor)).toEqual([null]);
      });

      it("mixed English and Arabic blocks in one selection follow each block's own default", () => {
        const editor = editorWith("<p>Hello</p><p>مرحبا</p>");
        editor.commands.selectAll();
        setAlign(editor, "right", auto);
        expect(aligns(editor)).toEqual(["right", null]);
        setAlign(editor, "left", auto);
        expect(aligns(editor)).toEqual([null, "left"]);
        setAlign(editor, "center", auto);
        expect(aligns(editor)).toEqual(["center", "center"]);
      });

      it("fixed directions keep one default for the whole note", () => {
        const editor = editorWith("<p>Hello</p><p>مرحبا</p>");
        editor.commands.selectAll();
        setAlign(editor, "right", { direction: "ltr" });
        expect(aligns(editor)).toEqual(["right", "right"]);
        setAlign(editor, "right", { direction: "rtl" });
        expect(aligns(editor)).toEqual([null, null]);
      });
    });

    it("firstStrongDirection follows the first strong character, as dir=auto does", () => {
      expect(firstStrongDirection("مرحبا Hello")).toBe("rtl");
      expect(firstStrongDirection("Hello مرحبا")).toBe("ltr");
      expect(firstStrongDirection("שלום")).toBe("rtl");
      expect(firstStrongDirection("12, (٣) – مرحبا")).toBe("rtl"); // digits and punctuation are not strong
      expect(firstStrongDirection("42 Été")).toBe("ltr");
      expect(firstStrongDirection("ދިވެހި")).toBe("rtl"); // Thaana
      expect(firstStrongDirection("Привет")).toBe("ltr");
      expect(firstStrongDirection("123 !?")).toBeNull();
      expect(firstStrongDirection("")).toBeNull();
    });

    it("setAlign applies to every block the selection touches", () => {
      const editor = editorWith("<p>one</p><p>two</p>");
      editor.commands.selectAll();
      setAlign(editor, "right", { direction: "ltr" });
      expect(editor.getJSON().content!.map((b) => b.attrs?.textAlign)).toEqual(["right", "right"]);
    });

    it("setWeight 400 removes fontWeight", () => {
      const editor = editorWith("<p>text</p>");
      editor.commands.selectAll();
      setWeight(editor, "600");
      expect(textStyleState(editor, plain).fontWeight).toBe("600");
      setWeight(editor, "400");
      expect(textStyleState(editor, plain).fontWeight).toBe("400");
      expect(JSON.stringify(editor.getJSON())).not.toContain("fontWeight");
    });
  });
});
