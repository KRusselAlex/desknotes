import { useEffect, useRef, type KeyboardEvent } from "react";
import { Icon } from "../../components/Icon";
import { COLOR_PRESETS } from "../appearance/colors";

/** Colour picker (design N8): 8 presets, current one ringed with a check. */
export function ColorPopover({
  current,
  onPick,
  onClose,
}: {
  current: string;
  onPick: (value: string) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    (ref.current?.querySelector<HTMLElement>('[aria-checked="true"]') ??
      ref.current?.querySelector<HTMLElement>("button"))?.focus();
  }, []);

  function onKeyDown(e: KeyboardEvent) {
    const nodes = Array.from(ref.current?.querySelectorAll<HTMLElement>("button") ?? []);
    const i = nodes.indexOf(document.activeElement as HTMLElement);
    const step = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: 4, ArrowUp: -4 }[e.key];
    if (step !== undefined) {
      nodes[(i + step + nodes.length) % nodes.length]?.focus();
      e.preventDefault();
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  }

  return (
    <div ref={ref} className="dn-popover dn-color-popover" role="dialog" aria-label="Note colour" onKeyDown={onKeyDown}>
      <div className="dn-popover-title">Colour</div>
      <div className="dn-swatches" role="radiogroup" aria-label="Colour">
        {COLOR_PRESETS.map((p) => {
          const selected = p.value === current.toLowerCase();
          return (
            <button
              key={p.value}
              type="button"
              role="radio"
              aria-checked={selected}
              aria-label={p.name}
              title={p.name}
              className="dn-swatch"
              style={{ background: p.value }}
              onClick={() => onPick(p.value)}
            >
              {selected && <Icon name="check" size={16} stroke={3} />}
            </button>
          );
        })}
      </div>
      <div className="dn-popover-later">
        <span className="dn-dashed-circle">
          <Icon name="plus" size={12} />
        </span>
        Custom colour (later)
      </div>
    </div>
  );
}
