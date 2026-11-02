/** Segmented control (design S1 "Lock after inactivity", S4 "Layout"): one choice of a few. */
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
  return (
    <div className="dn-segmented" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          role="radio"
          aria-checked={o.value === value}
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
