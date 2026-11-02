import { useState } from "react";
import type { NoteSize } from "../../types/note";

type Draft = { width: string; height: string };

const toDraft = (size: NoteSize): Draft => ({ width: String(size.width), height: String(size.height) });

/**
 * "Minimum note size" row (design S2): two pill fields, saved on Enter or when
 * focus leaves. The native layer checks the range; on refusal the saved value
 * comes back and the Settings window shows the reason.
 */
export function MinNoteSize({ value, onSave }: { value: NoteSize; onSave: (size: NoteSize) => Promise<boolean> }) {
  const [draft, setDraft] = useState<Draft>(() => toDraft(value));
  // When a saved side changes, show it (React's "adjust state on prop change").
  // Only that side: the other field may hold something the person is still typing.
  const [shown, setShown] = useState(value);
  if (shown.width !== value.width || shown.height !== value.height) {
    setShown(value);
    setDraft((d) => ({
      width: shown.width !== value.width ? String(value.width) : d.width,
      height: shown.height !== value.height ? String(value.height) : d.height,
    }));
  }

  async function commit() {
    const width = /^\d+$/.test(draft.width.trim()) ? Number(draft.width) : NaN;
    const height = /^\d+$/.test(draft.height.trim()) ? Number(draft.height) : NaN;
    if (Number.isNaN(width) || Number.isNaN(height)) {
      setDraft(toDraft(value));
      return;
    }
    if (width === value.width && height === value.height) return;
    if (!(await onSave({ width, height }))) setDraft(toDraft(value));
  }

  const field = (side: keyof Draft, label: string) => (
    <input
      className="dn-size-field"
      inputMode="numeric"
      maxLength={3} // the range ends at 600
      aria-label={label}
      value={draft[side]}
      onChange={(e) => setDraft((d) => ({ ...d, [side]: e.target.value }))}
      onBlur={() => void commit()}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur(); // blur saves
      }}
    />
  );

  return (
    <div className="dn-size-fields">
      {field("width", "Minimum width")}×{field("height", "Minimum height")}
      <span className="dn-muted">px</span>
    </div>
  );
}
