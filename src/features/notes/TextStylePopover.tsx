import { useEffect, useId, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { useEditorState, type Editor } from "@tiptap/react";
import { Icon } from "../../components/Icon";
import type { IconName } from "../../components/icons";
import { commands } from "../../ipc/commands";
import type { Appearance } from "../../types/note";
import {
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  FONT_WEIGHTS,
  HIGHLIGHT_COLORS,
  TEXT_STYLE_COLORS,
  changeCase,
  setAlign,
  setTextColor,
  setWeight,
  styleChain,
  textStyleState,
  type StyleOptions,
  type FontWeightValue,
  type TextAlignment,
} from "./textStyle";

/** Swatch names and their tokens in `tokens.css`, keyed by the stored colour. */
const TEXT_SWATCHES: Record<string, { name: string; token: string }> = {
  "#201e1d": { name: "Black text", token: "--dn-text-ink" },
  "#8c491a": { name: "Brown text", token: "--dn-text-brown" },
  "#56633f": { name: "Green text", token: "--dn-text-olive" },
  "#1d4f91": { name: "Blue text", token: "--dn-text-blue" },
  "#7a1b14": { name: "Red text", token: "--dn-text-red" },
  "#5b3a8c": { name: "Violet text", token: "--dn-text-violet" },
};
const HIGHLIGHT_SWATCHES: Record<string, { name: string; token: string }> = {
  "#ffe36e": { name: "Yellow highlight", token: "--dn-highlight-yellow" },
  "#ffc6a5": { name: "Peach highlight", token: "--dn-highlight-peach" },
  "#ccdbb2": { name: "Green highlight", token: "--dn-highlight-sage" },
  "#bcd9ff": { name: "Blue highlight", token: "--dn-highlight-sky" },
};

const ALIGN_BUTTONS: { value: TextAlignment; label: string; icon: IconName }[] = [
  { value: "left", label: "Align left", icon: "alignleft" },
  { value: "center", label: "Align centre", icon: "aligncenter" },
  { value: "right", label: "Align right", icon: "alignright" },
];

// Installed fonts, asked for once per note window, the first time the popover opens.
let installedFonts: Promise<string[]> | null = null;
function loadFonts(): Promise<string[]> {
  installedFonts ??= commands.listFonts().catch(() => []);
  return installedFonts;
}

/**
 * A press anywhere in the popover keeps focus (and the selection) in the editor, as the
 * bar's tools do; otherwise the note would see focus leave and stop editing. A select
 * must take focus to open, so it is left alone.
 */
const keepEditorFocus = (e: MouseEvent) => {
  if (!(e.target as Element).closest("select")) e.preventDefault();
};

interface Swatch {
  key: string;
  name: string;
  checked: boolean;
  /** CSS colour of the swatch; none for the "No highlight" swatch. */
  fill?: string;
  content?: ReactNode;
  onPick: () => void;
}

/** One row of swatches: a radiogroup where only the current one is in the Tab order (N8). */
function SwatchGroup({ labelId, swatches }: { labelId: string; swatches: Swatch[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const current = Math.max(0, swatches.findIndex((s) => s.checked));

  function onKeyDown(e: KeyboardEvent) {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    if (step === undefined) return;
    const nodes = Array.from(ref.current?.querySelectorAll<HTMLElement>('[role="radio"]') ?? []);
    const i = nodes.indexOf(document.activeElement as HTMLElement);
    nodes[(i + step + nodes.length) % nodes.length]?.focus();
    e.preventDefault();
  }

  return (
    <div ref={ref} className="dn-ts-swatches" role="radiogroup" aria-labelledby={labelId} onKeyDown={onKeyDown}>
      {swatches.map((s, i) => (
        <button
          key={s.key}
          type="button"
          role="radio"
          aria-checked={s.checked}
          aria-label={s.name}
          title={s.name}
          tabIndex={i === current ? 0 : -1}
          className={`dn-ts-swatch${s.fill ? "" : " is-none"}`}
          style={s.fill ? { background: s.fill } : undefined}
          onClick={s.onPick}
        >
          {s.content}
        </button>
      ))}
    </div>
  );
}

/**
 * The Aa text-style popover (design N14): font, size, weight, text colour,
 * highlight, alignment, case and undo/redo for the current selection. It never
 * takes focus, so the selection stays visible; choosing a value keeps it open.
 */
export function TextStylePopover({
  editor,
  appearance,
  onClose,
}: {
  editor: Editor;
  appearance: Appearance;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const id = useId();
  const [fonts, setFonts] = useState<string[] | null>(null);
  const s = useEditorState({ editor, selector: ({ editor: e }) => textStyleState(e, appearance) });

  useEffect(() => {
    let live = true;
    void loadFonts().then((f) => {
      if (live) setFonts(f);
    });
    return () => {
      live = false;
    };
  }, []);

  // Esc (from the popover or the editor) and a click outside close it. A click on a
  // popover toggle (Aa itself) is left to that toggle.
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      onClose();
    };
    const onDown = (e: PointerEvent) => {
      const t = e.target as Element;
      if (!ref.current?.contains(t) && !t.closest("[data-popover-toggle]")) onClose();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onDown);
    };
  }, [onClose]);

  // A control used from the keyboard (or a select) has focus: keep it there so several
  // changes can be made in a row. A mouse press leaves focus in the text (keepEditorFocus).
  const opts = (): StyleOptions => ({ focus: !ref.current?.contains(document.activeElement) });
  const chain = () => styleChain(editor, opts());
  const font = s.fontFamily ?? "";
  const setSize = (px: number) =>
    chain().setFontSize(`${Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, px))}px`).run();

  return (
    <div
      ref={ref}
      className="dn-popover dn-text-style"
      role="dialog"
      aria-label="Text style"
      onMouseDown={keepEditorFocus}
    >
      <div className="dn-ts-grid">
        <label className="dn-ts-label" htmlFor={`${id}-font`}>
          Font
        </label>
        <span className="dn-ts-select">
          <select
            id={`${id}-font`}
            value={font}
            onChange={(e) => {
              const v = e.target.value;
              if (v === "") chain().unsetFontFamily().run();
              else chain().setFontFamily(v).run();
            }}
          >
            <option value="">System default</option>
            {font && !(fonts ?? []).includes(font) && (
              <option value={font}>{fonts ? `${font} (not installed)` : font}</option>
            )}
            {(fonts ?? []).map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
          <Icon name="chevdown" size={13} />
        </span>

        <span className="dn-ts-label" id={`${id}-size`}>
          Size
        </span>
        <div className="dn-ts-size-row">
          <span className="dn-ts-stepper" role="group" aria-labelledby={`${id}-size`}>
            <button
              type="button"
              aria-label="Smaller text"
              disabled={s.fontSize <= FONT_SIZE_MIN}
                  onClick={() => setSize(s.fontSize - 1)}
            >
              −
            </button>
            <span className="dn-ts-stepper-value" aria-live="polite">
              {s.fontSize}
            </span>
            <button
              type="button"
              aria-label="Larger text"
              disabled={s.fontSize >= FONT_SIZE_MAX}
                  onClick={() => setSize(s.fontSize + 1)}
            >
              +
            </button>
          </span>
          <span className="dn-ts-select dn-ts-weight">
            <select
              aria-label="Weight"
              value={s.fontWeight}
              onChange={(e) => setWeight(editor, e.target.value as FontWeightValue, opts())}
            >
              {FONT_WEIGHTS.map((w) => (
                <option key={w.value} value={w.value}>
                  {w.label}
                </option>
              ))}
            </select>
            <Icon name="chevdown" size={13} />
          </span>
        </div>

        <span className="dn-ts-label" id={`${id}-text`}>
          Text
        </span>
        <SwatchGroup
          labelId={`${id}-text`}
          swatches={TEXT_STYLE_COLORS.map((c) => ({
            key: c,
            name: TEXT_SWATCHES[c]!.name,
            fill: `var(${TEXT_SWATCHES[c]!.token})`,
            checked: s.color === c,
            onPick: () => setTextColor(editor, c, appearance, opts()),
          }))}
        />

        <span className="dn-ts-label" id={`${id}-highlight`}>
          Highlight
        </span>
        <SwatchGroup
          labelId={`${id}-highlight`}
          swatches={[
            {
              key: "none",
              name: "No highlight",
              checked: s.highlight === null,
              content: <Icon name="close" size={11} />,
              onPick: () => chain().unsetHighlight().run(),
            },
            ...HIGHLIGHT_COLORS.map((c) => ({
              key: c,
              name: HIGHLIGHT_SWATCHES[c]!.name,
              fill: `var(${HIGHLIGHT_SWATCHES[c]!.token})`,
              checked: s.highlight === c,
              onPick: () => chain().setHighlight({ color: c }).run(),
            })),
          ]}
        />
      </div>

      <div className="dn-ts-actions">
        {ALIGN_BUTTONS.map((a) => (
          <button
            key={a.value}
            type="button"
            className="dn-tool"
            aria-label={a.label}
            title={a.label}
            aria-pressed={s.align === a.value}
              onClick={() => setAlign(editor, a.value, appearance, opts())}
          >
            <Icon name={a.icon} />
          </button>
        ))}
        <span className="dn-format-divider" aria-hidden="true" />
        <button
          type="button"
          className="dn-tool dn-ts-case"
          disabled={!s.hasSelection}
          onClick={() => changeCase(editor, "upper")}
        >
          AB
        </button>
        <button
          type="button"
          className="dn-tool dn-ts-case"
          disabled={!s.hasSelection}
          onClick={() => changeCase(editor, "lower")}
        >
          ab
        </button>
        <span className="dn-spacer" />
        <button
          type="button"
          className="dn-tool"
          aria-label="Undo"
          title="Undo (Ctrl+Z)"
          disabled={!s.canUndo}
          onClick={() => chain().undo().run()}
        >
          <Icon name="undo" />
        </button>
        <button
          type="button"
          className="dn-tool"
          aria-label="Redo"
          title="Redo (Ctrl+Shift+Z)"
          disabled={!s.canRedo}
          onClick={() => chain().redo().run()}
        >
          <Icon name="redo" />
        </button>
      </div>
    </div>
  );
}
