import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Icon } from "../../components/Icon";
import { Segmented } from "../../components/Segmented";
import { Switch } from "../../components/Switch";
import { commands } from "../../ipc/commands";
import { onNoteResized, onNoteSettingsNote, onNotesChanged } from "../../ipc/events";
import { closeCurrentWindow } from "../../ipc/window";
import type { Appearance, Note, NoteSize, TextDirection } from "../../types/note";
import {
  APPEARANCE_DEFAULTS,
  FONT_SIZE_RANGE,
  LINE_SPACING_RANGE,
  OPACITY_RANGE,
  TEXT_COLORS,
  effectiveAppearance,
} from "../appearance/appearance";
import { COLOR_PRESETS, contrastRatio } from "../appearance/colors";
import { useAppAppearance } from "../appearance/useAppAppearance";

/** Size of a new note (tokens --dn-note-w / --dn-note-h); the native side raises it to the minimum note size. */
const DEFAULT_SIZE: NoteSize = { width: 300, height: 280 };
/** A slider sends at most one change per this many milliseconds while it moves. */
const SLIDER_SEND_MS = 100;
/** Below this contrast between text and background, the Background card warns (WCAG AA). */
const READABLE_CONTRAST = 4.5;

const TEXT_COLOR_NAMES: Record<(typeof TEXT_COLORS)[number], string> = {
  "#201e1d": "Black text",
  "#8c491a": "Brown text",
  "#56633f": "Green text",
  "#1d4f91": "Blue text",
};

const DIRECTIONS: readonly { value: TextDirection; label: string }[] = [
  { value: "auto", label: "Automatic" },
  { value: "ltr", label: "LTR" },
  { value: "rtl", label: "RTL" },
];

/** The appearance with `patch` applied, without keys that are unset or at their default.
 * The size is the exception: the default it is compared with is `defaultSize`, the size
 * the stepper shows when the note has none (the app default, × 0.9 in Compact, rounded to
 * whole pixels), and only when the patch sets it. Stepping back to that size leaves it unset
 * so the note follows the app again; a size the note already has is never dropped by another
 * change. */
function merged(current: Appearance, patch: Appearance, defaultSize: number): Appearance {
  const next: Record<string, unknown> = { ...current, ...patch };
  const defaults: Record<string, unknown> = APPEARANCE_DEFAULTS;
  for (const key of Object.keys(next)) {
    if (next[key] === undefined || (key !== "fontSize" && next[key] === defaults[key])) delete next[key];
  }
  if (patch.fontSize !== undefined && patch.fontSize === defaultSize) delete next.fontSize;
  return next as Appearance;
}

/** The settings window has nothing left to show: its note was hidden, archived, done or trashed. */
function isGone(n: Note): boolean {
  return !n.window.visible || n.archivedAt !== null || n.deletedAt !== null || n.completedAt !== null;
}

/**
 * Note settings window (design "Note settings", B): text, background, size and
 * behaviour of one note, applied live. It never shows the note's text, only a
 * swatch of its colour. It closes itself when the note is hidden, archived,
 * done, trashed or gone, and switches note on `note-settings-note`.
 */
export function NoteSettingsWindow({ noteId: firstNoteId }: { noteId: string }) {
  const [noteId, setNoteId] = useState(firstNoteId);
  const [color, setColor] = useState<string | null>(null);
  const [appearance, setAppearance] = useState<Appearance>({});
  /** Null until the shown note's first read has landed. */
  const [size, setSize] = useState<NoteSize | null>(null);
  const [editLocked, setEditLocked] = useState(false);
  const [onTop, setOnTop] = useState(false);
  const [fonts, setFonts] = useState<string[] | null>(null);
  /** Height / width kept while "Lock aspect ratio" is on. */
  const [aspect, setAspect] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Settings → Appearance: fills the font and size a note leaves unset (shown, never stored). */
  const app = useAppAppearance();
  const defaultSize = app ? (effectiveAppearance({}, app).fontSize ?? APPEARANCE_DEFAULTS.fontSize) : APPEARANCE_DEFAULTS.fontSize;
  /** The size the stepper shows for a note without one (Compact's 13.5 shows as 14). */
  const shownDefaultSize = Math.round(defaultSize);

  // Latest values for sends that happen later (throttled sliders, async results).
  const idRef = useRef(noteId);
  /** Counts note switches. An answer that belongs to an earlier note is ignored. */
  const generation = useRef(0);
  /** The generation whose first read has landed; later reads wait for it. */
  const readGeneration = useRef(-1);
  const appearanceRef = useRef<Appearance>({});
  /** Appearance changes to the shown note sent and not answered yet. */
  const inFlight = useRef(0);
  const dragging = useRef(false);
  const lastSend = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef(false);

  /** `flushAppearance`, reachable from callbacks that are defined before it. */
  const flushRef = useRef<() => void>(() => undefined);
  /** Close this window. A slider value still waiting to go out is sent first. */
  const closeWindow = useCallback(() => {
    flushRef.current();
    void closeCurrentWindow();
  }, []);

  const showAppearance = useCallback((next: Appearance) => {
    appearanceRef.current = next;
    setAppearance(next);
  }, []);

  /** Read the note again. A missing, hidden, archived or trashed note closes the window.
   * `first`: the note is being shown (opened or switched to); its saved settings and size
   * are taken as they are. The size is read only then: the saved size can lag behind the
   * window, so afterwards the size comes from `setNoteSize` results and `note-resized`. */
  const refresh = useCallback(
    (id: string, first: boolean) => {
      const gen = generation.current;
      commands.getNote(id).then(
        (n) => {
          if (generation.current !== gen) return;
          if (isGone(n)) {
            closeWindow();
            return;
          }
          // Until the note's first read has landed, the window shows nothing of it.
          if (!first && readGeneration.current !== gen) return;
          setColor(n.color);
          // A slider being moved, or a change on its way, wins over what was saved before it.
          if (first || (!dragging.current && !pending.current && inFlight.current === 0)) {
            showAppearance(n.appearance);
          }
          setEditLocked(n.editLocked);
          setOnTop(n.window.alwaysOnTop);
          if (first) {
            setSize({ width: n.window.width, height: n.window.height });
            readGeneration.current = gen;
          }
        },
        () => {
          if (generation.current === gen) closeWindow();
        },
      );
    },
    [showAppearance, closeWindow],
  );

  /** Run a change to the shown note; on refusal show why and read the note again.
   * The answer is ignored if another note is shown by then. */
  const run = useCallback(
    (action: () => Promise<unknown>) => {
      const gen = generation.current;
      action().then(
        () => {
          if (generation.current === gen) setError(null);
        },
        (e: Error) => {
          if (generation.current !== gen) return;
          setError(e.message);
          refresh(idRef.current, false);
        },
      );
    },
    [refresh],
  );

  const sendAppearanceNow = useCallback(() => {
    pending.current = false;
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    lastSend.current = Date.now();
    const id = idRef.current;
    const value = appearanceRef.current;
    const gen = generation.current;
    inFlight.current += 1;
    run(() =>
      commands.setNoteAppearance(id, value).finally(() => {
        if (generation.current === gen) inFlight.current -= 1;
      }),
    );
  }, [run]);

  /** Send what a slider shows: at once if nothing went out in the last 100 ms, else when that time is up. */
  const sendAppearanceSoon = useCallback(() => {
    const wait = SLIDER_SEND_MS - (Date.now() - lastSend.current);
    if (wait <= 0 && timer.current === null) {
      sendAppearanceNow();
      return;
    }
    pending.current = true;
    timer.current ??= setTimeout(sendAppearanceNow, Math.max(wait, 0));
  }, [sendAppearanceNow]);

  /** A slider was let go: send its last value now if it has not gone out. */
  const flushAppearance = useCallback(() => {
    dragging.current = false;
    if (pending.current) sendAppearanceNow();
  }, [sendAppearanceNow]);
  useEffect(() => {
    flushRef.current = flushAppearance;
  }, [flushAppearance]);

  function changeAppearance(patch: Appearance) {
    showAppearance(merged(appearanceRef.current, patch, shownDefaultSize));
    sendAppearanceNow();
  }

  function slide(patch: Appearance) {
    showAppearance(merged(appearanceRef.current, patch, shownDefaultSize));
    sendAppearanceSoon();
  }

  function changeColor(next: string) {
    const id = idRef.current;
    setColor(next);
    run(() => commands.setNoteColor(id, next));
  }

  /** Resize the note and show the size that was applied (limited by the native side).
   * Null when it was refused, or when another note is shown by the time it answers. */
  function resize(width: number, height: number): Promise<NoteSize | null> {
    const id = idRef.current;
    const gen = generation.current;
    return commands.setNoteSize(id, width, height).then(
      (applied) => {
        if (generation.current !== gen) return null;
        setSize(applied);
        setError(null);
        return applied;
      },
      (e: Error) => {
        if (generation.current === gen) setError(e.message);
        return null;
      },
    );
  }

  function resetToDefaults() {
    showAppearance({});
    sendAppearanceNow();
    void resize(DEFAULT_SIZE.width, DEFAULT_SIZE.height);
  }

  // The note the window opened for (a switch reads its note in the handler below).
  useEffect(() => refresh(idRef.current, true), [refresh]);

  // Installed fonts, read once per window opening.
  useEffect(() => {
    commands.listFonts().then(setFonts, () => setFonts([]));
  }, []);

  useEffect(() => {
    document.title = "Note settings"; // never the note's text
  }, []);

  useEffect(() => {
    // Outside the app (tests, preview without events) there may be nothing to listen to.
    const unlisteners = [
      onNotesChanged((e) => {
        if (e.id === null || e.id === idRef.current) refresh(idRef.current, false);
      }),
      onNoteResized((e) => {
        if (e.id === idRef.current) setSize({ width: Math.round(e.width), height: Math.round(e.height) });
      }),
      onNoteSettingsNote((id) => {
        flushAppearance(); // a slider value still waiting goes to the previous note
        // From here on nothing of the previous note is shown or sent: answers for it are
        // ignored, and the controls stay hidden until the new note has been read.
        generation.current += 1;
        idRef.current = id;
        inFlight.current = 0;
        pending.current = false;
        dragging.current = false;
        showAppearance({});
        setColor(null);
        setSize(null);
        setAspect(null);
        setError(null);
        setNoteId(id);
        // Read here, not in an effect: the window may be asked again for the note it shows.
        refresh(id, true);
      }),
    ].map((p) => p.catch(() => null));
    return () => unlisteners.forEach((p) => void p.then((f) => f?.()));
  }, [refresh, flushAppearance, showAppearance]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) closeWindow();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [closeWindow]);

  // Closing: a slider value still waiting goes out.
  useEffect(() => () => flushAppearance(), [flushAppearance]);

  // The size the note is drawn with, in whole pixels (Compact's 13.5 shows as 14); the
  // stepper steps from it.
  const fontSize = appearance.fontSize === undefined ? shownDefaultSize : Math.round(appearance.fontSize);
  const textColor = appearance.textColor ?? APPEARANCE_DEFAULTS.textColor;
  const lineSpacing = appearance.lineSpacing ?? APPEARANCE_DEFAULTS.lineSpacing;
  const opacity = appearance.opacity ?? APPEARANCE_DEFAULTS.opacity;
  const direction = appearance.direction ?? APPEARANCE_DEFAULTS.direction;
  const font = appearance.font ?? "";
  const ready = color !== null && size !== null && app !== null;
  const isPreset = color !== null && COLOR_PRESETS.some((p) => p.value === color.toLowerCase());

  const sliderEvents = {
    onPointerDown: () => (dragging.current = true),
    onPointerUp: flushAppearance,
    onKeyUp: flushAppearance,
    onBlur: flushAppearance,
  };

  return (
    <div className="dn-ns">
      <div className="dn-ns-scroll">
        {ready && (
          <div className="dn-ns-head">
            <span className="dn-ns-note-swatch" role="img" aria-label="Note colour" style={{ backgroundColor: color }} />
          </div>
        )}
        {error && (
          <div className="dn-banner-error" role="alert">
            <Icon name="alert" size={18} />
            <span>{error}</span>
          </div>
        )}
        {ready && (
          <>
            <Card title="Text">
              <div className="dn-ns-row">
                <label htmlFor="dn-ns-font">Font</label>
                <span className="dn-ns-select">
                  <select
                    id="dn-ns-font"
                    value={font}
                    onChange={(e) => changeAppearance({ font: e.target.value || undefined })}
                  >
                    {/* No font of its own: the note is drawn with the app's default font, if any. */}
                    <option value="">{app?.defaultFont ? `${app.defaultFont} (default)` : "System default"}</option>
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
              </div>
              <div className="dn-ns-row">
                <span id="dn-ns-size-label">Size</span>
                <span className="dn-ns-stepper" role="group" aria-labelledby="dn-ns-size-label">
                  <button
                    type="button"
                    aria-label="Smaller text"
                    disabled={fontSize <= FONT_SIZE_RANGE.min}
                    onClick={() => changeAppearance({ fontSize: Math.max(FONT_SIZE_RANGE.min, fontSize - 1) })}
                  >
                    −
                  </button>
                  <span className="dn-ns-stepper-value" aria-live="polite">
                    {fontSize}
                  </span>
                  <button
                    type="button"
                    aria-label="Larger text"
                    disabled={fontSize >= FONT_SIZE_RANGE.max}
                    onClick={() => changeAppearance({ fontSize: Math.min(FONT_SIZE_RANGE.max, fontSize + 1) })}
                  >
                    +
                  </button>
                </span>
              </div>
              <div className="dn-ns-row">
                <span id="dn-ns-ink-label">Text colour</span>
                <span className="dn-ns-inks" role="radiogroup" aria-labelledby="dn-ns-ink-label">
                  {TEXT_COLORS.map((c) => (
                    <button
                      key={c}
                      type="button"
                      role="radio"
                      aria-checked={textColor === c}
                      aria-label={TEXT_COLOR_NAMES[c]}
                      style={{ backgroundColor: c }}
                      onClick={() => changeAppearance({ textColor: c })}
                    />
                  ))}
                </span>
              </div>
              <Slider
                label="Line spacing"
                range={LINE_SPACING_RANGE}
                value={lineSpacing}
                onSlide={(v) => slide({ lineSpacing: v })}
                events={sliderEvents}
              />
              <div className="dn-ns-row">
                <span>Direction</span>
                <Segmented
                  label="Direction"
                  options={DIRECTIONS}
                  value={direction}
                  onChange={(d) => changeAppearance({ direction: d })}
                />
              </div>
            </Card>

            <Card title="Background">
              <div className="dn-ns-swatches" role="radiogroup" aria-label="Background colour">
                {COLOR_PRESETS.map((p) => (
                  <button
                    key={p.value}
                    type="button"
                    role="radio"
                    aria-checked={color.toLowerCase() === p.value}
                    aria-label={p.name}
                    style={{ backgroundColor: p.value }}
                    onClick={() => changeColor(p.value)}
                  />
                ))}
                <label
                  className={`dn-ns-custom${isPreset ? "" : " is-chosen"}`}
                  style={isPreset ? undefined : { backgroundColor: color }}
                >
                  <input
                    type="color"
                    aria-label="Custom colour"
                    value={color}
                    onChange={(e) => changeColor(e.target.value.toLowerCase())}
                  />
                  {isPreset && <Icon name="plus" size={12} />}
                </label>
              </div>
              {contrastRatio(textColor, color) < READABLE_CONTRAST && (
                <span className="dn-ns-hint" role="status">
                  Text may be hard to read on this colour.
                </span>
              )}
              <div className="dn-ns-stack">
                <Slider
                  label="Opacity"
                  range={OPACITY_RANGE}
                  value={opacity}
                  floor
                  onSlide={(v) => slide({ opacity: v })}
                  events={sliderEvents}
                />
                <span className="dn-ns-hint">
                  Lowest allowed: 80 %, so text stays readable. Needs a compositor; ignored otherwise.
                </span>
              </div>
              <div className="dn-ns-row is-later" aria-disabled="true">
                <span>Background image</span>{" "}
                <span className="dn-ns-later">Later</span>
              </div>
            </Card>

            <Card title="Size">
              <SizeFields key={noteId} size={size} aspect={aspect} onResize={resize} />
              <div className="dn-ns-row">
                <span>Lock aspect ratio</span>
                <Switch
                  label="Lock aspect ratio"
                  checked={aspect !== null}
                  onChange={(on) => setAspect(on ? size.height / size.width : null)}
                />
              </div>
            </Card>

            <Card title="Behaviour">
              <div className="dn-ns-row">
                <span>Lock editing</span>
                <Switch
                  label="Lock editing"
                  checked={editLocked}
                  onChange={(on) => {
                    const id = idRef.current;
                    setEditLocked(on);
                    run(() => commands.setEditLocked(id, on));
                  }}
                />
              </div>
              <div className="dn-ns-row">
                <span>Always on top</span>
                <Switch
                  label="Always on top"
                  checked={onTop}
                  onChange={(on) => {
                    const id = idRef.current;
                    setOnTop(on);
                    run(() => commands.setAlwaysOnTop(id, on));
                  }}
                />
              </div>
            </Card>
          </>
        )}
      </div>
      <footer className="dn-ns-footer">
        <button type="button" className="dn-ns-link" disabled={!ready} onClick={resetToDefaults}>
          Reset to defaults
        </button>
        <span className="dn-ns-spacer" />
        <button type="button" className="dn-ns-close" onClick={closeWindow}>
          Close
        </button>
      </footer>
    </div>
  );
}

function Card({ title, children }: { title: string; children: ReactNode }) {
  const id = `dn-ns-card-${title.toLowerCase()}`;
  return (
    <section className="dn-ns-card" aria-labelledby={id}>
      <h2 id={id} className="dn-ns-card-title">
        {title}
      </h2>
      {children}
    </section>
  );
}

interface SliderEvents {
  onPointerDown: () => void;
  onPointerUp: () => void;
  onKeyUp: () => void;
  onBlur: () => void;
}

/** Slider with its value as "145 %" (design "Line spacing" / "Opacity"). `floor` marks the lowest allowed value. */
function Slider({
  label,
  range,
  value,
  floor,
  onSlide,
  events,
}: {
  label: string;
  range: { min: number; max: number; step: number };
  value: number;
  floor?: boolean;
  onSlide: (value: number) => void;
  events: SliderEvents;
}) {
  const fill = ((value - range.min) / (range.max - range.min)) * 100;
  return (
    <div className="dn-ns-row is-slider">
      <span className="dn-ns-slider-label">{label}</span>
      <span className={`dn-ns-track${floor ? " has-floor" : ""}`}>
        <input
          type="range"
          aria-label={label}
          min={range.min}
          max={range.max}
          step={range.step}
          value={value}
          style={{ "--fill": `${fill}%` } as CSSProperties}
          onChange={(e) => onSlide(Number(e.target.value))}
          {...events}
        />
      </span>
      <span className="dn-ns-readout">{value} %</span>
    </div>
  );
}

type Draft = { width: string; height: string };
const toDraft = (s: NoteSize): Draft => ({ width: String(s.width), height: String(s.height) });

/** W × H pill fields and "Reset size" (design "Size"), applied on Enter or when focus leaves. */
function SizeFields({
  size,
  aspect,
  onResize,
}: {
  size: NoteSize;
  aspect: number | null;
  onResize: (width: number, height: number) => Promise<NoteSize | null>;
}) {
  const [draft, setDraft] = useState<Draft>(() => toDraft(size));
  // Show a new size as it arrives (React's "adjust state on prop change").
  const [shown, setShown] = useState(size);
  if (shown.width !== size.width || shown.height !== size.height) {
    setShown(size);
    setDraft(toDraft(size));
  }

  function apply(width: number, height: number) {
    // On refusal show the current size again. An answer for another note gives null
    // too, but this component belongs to one note (keyed by its id) and is gone by then.
    void onResize(width, height).then((applied) => setDraft(toDraft(applied ?? size)));
  }

  function commit(side: keyof Draft) {
    const raw = draft[side].trim();
    if (!/^\d+$/.test(raw)) {
      setDraft(toDraft(size));
      return;
    }
    let width = side === "width" ? Number(raw) : size.width;
    let height = side === "height" ? Number(raw) : size.height;
    if (aspect !== null) {
      if (side === "width") height = Math.round(width * aspect);
      else width = Math.round(height / aspect);
    }
    if (width === size.width && height === size.height) {
      setDraft(toDraft(size));
      return;
    }
    apply(width, height);
  }

  const field = (side: keyof Draft, label: string, letter: string) => (
    <label className="dn-ns-dim">
      <input
        inputMode="numeric"
        maxLength={5}
        aria-label={label}
        value={draft[side]}
        onChange={(e) => setDraft((d) => ({ ...d, [side]: e.target.value }))}
        onBlur={() => commit(side)}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur(); // blur applies
        }}
      />
      <span aria-hidden="true">{letter}</span>
    </label>
  );

  return (
    <div className="dn-ns-dims">
      {field("width", "Width", "W")}×{field("height", "Height", "H")}
      <span className="dn-ns-spacer" />
      <button
        type="button"
        className="dn-ns-link is-small"
        onClick={() => apply(DEFAULT_SIZE.width, DEFAULT_SIZE.height)}
      >
        Reset size
      </button>
    </div>
  );
}
