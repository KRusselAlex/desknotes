/** On/off switch (design S1/S2: 38 × 22 pill). */
export function Switch({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      className="dn-switch"
      onClick={() => onChange(!checked)}
    >
      <span className="dn-switch-knob" />
    </button>
  );
}
