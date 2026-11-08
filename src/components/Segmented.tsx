import { useRef, type KeyboardEvent } from "react";

const STEPS: Record<string, number> = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };

/**
 * Segmented control (design S1 "Lock after inactivity", S4 "Layout"): one choice of a few.
 * A radiogroup where only the chosen option is in the Tab order; arrow keys, Home and End
 * move between options and Space or Enter chooses, like the swatch rows (N8).
 */
export function Segmented<T extends string | number>({
  label,
  options,
  value,
  onChange,
  disabled,
}: {
  /** Accessible name of the group. */
  label: string;
  options: readonly { value: T; label: string }[];
  value: T | null;
  onChange: (next: T) => void;
  disabled?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const tabbable = Math.max(
    0,
    options.findIndex((o) => o.value === value),
  );

  function onKeyDown(e: KeyboardEvent) {
    const nodes = Array.from(ref.current?.querySelectorAll<HTMLElement>('[role="radio"]') ?? []);
    const at = nodes.indexOf(document.activeElement as HTMLElement);
    let next: number;
    if (e.key === "Home") next = 0;
    else if (e.key === "End") next = nodes.length - 1;
    else if (STEPS[e.key] !== undefined) next = (at + STEPS[e.key]! + nodes.length) % nodes.length;
    else return;
    nodes[next]?.focus();
    e.preventDefault();
  }

  return (
    <div ref={ref} className="dn-segmented" role="radiogroup" aria-label={label} onKeyDown={onKeyDown}>
      {options.map((o, i) => (
        <button
          key={String(o.value)}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          tabIndex={i === tabbable ? 0 : -1}
          disabled={disabled}
          onClick={() => {
            if (o.value !== value) onChange(o.value);
          }}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
