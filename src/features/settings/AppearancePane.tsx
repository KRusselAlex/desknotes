import { useEffect, useState } from "react";
import { Icon } from "../../components/Icon";
import { Segmented } from "../../components/Segmented";
import { Switch } from "../../components/Switch";
import { commands } from "../../ipc/commands";
import { APP_APPEARANCE_DEFAULTS, type AppAppearance, type Layout } from "../../types/note";
import { FONT_SIZE_RANGE } from "../appearance/appearance";

const LAYOUTS: readonly { value: Layout; label: string }[] = [
  { value: "compact", label: "Compact" },
  { value: "comfortable", label: "Comfortable" },
];

/**
 * Settings → Appearance (design S4): how every note looks by default. It shows `value`
 * and reports each change as a whole new value; the Settings window saves it.
 */
export function AppearancePane({ value, onChange }: { value: AppAppearance; onChange: (next: AppAppearance) => void }) {
  const [fonts, setFonts] = useState<string[] | null>(null);
  // Installed fonts, read once per pane opening (as in Note settings).
  useEffect(() => {
    commands.listFonts().then(setFonts, () => setFonts([]));
  }, []);

  const change = (patch: Partial<AppAppearance>) => onChange({ ...value, ...patch });
  const font = value.defaultFont ?? "";
  const size = value.defaultSize;

  return (
    <>
      <h1>Appearance</h1>
      <div className="dn-ap">
        <div className="dn-ap-row">
          <span className="dn-ap-label">High-contrast notes</span>
          <Switch
            label="High-contrast notes"
            checked={value.highContrast}
            onChange={(highContrast) => change({ highContrast })}
          />
        </div>
        <div className="dn-ap-row">
          <span className="dn-ap-label">Layout</span>
          <Segmented label="Layout" options={LAYOUTS} value={value.layout} onChange={(layout) => change({ layout })} />
        </div>
        <div className="dn-ap-row">
          <label className="dn-ap-label" htmlFor="dn-ap-font">
            Default font
          </label>
          <span className="dn-ns-select">
            <select id="dn-ap-font" value={font} onChange={(e) => change({ defaultFont: e.target.value || null })}>
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
        </div>
        <div className="dn-ap-row">
          <span className="dn-ap-label" id="dn-ap-size-label">
            Default size
          </span>
          <span className="dn-ns-stepper" role="group" aria-labelledby="dn-ap-size-label">
            <button
              type="button"
              aria-label="Smaller default size"
              disabled={size <= FONT_SIZE_RANGE.min}
              onClick={() => change({ defaultSize: Math.max(FONT_SIZE_RANGE.min, size - 1) })}
            >
              −
            </button>
            <span className="dn-ns-stepper-value" aria-live="polite">
              {size}
            </span>
            <button
              type="button"
              aria-label="Larger default size"
              disabled={size >= FONT_SIZE_RANGE.max}
              onClick={() => change({ defaultSize: Math.min(FONT_SIZE_RANGE.max, size + 1) })}
            >
              +
            </button>
          </span>
        </div>
        <button type="button" className="dn-btn-link dn-ap-reset" onClick={() => onChange({ ...APP_APPEARANCE_DEFAULTS })}>
          Reset appearance
        </button>
      </div>
    </>
  );
}
