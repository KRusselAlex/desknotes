import { moveAmongRadios, tabStop } from "./radioKeys";

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
  const tabbable = tabStop(options.map((o) => o.value === value));

  return (
    <div className="dn-segmented" role="radiogroup" aria-label={label} onKeyDown={moveAmongRadios}>
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
