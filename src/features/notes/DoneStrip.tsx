import { useEffect, useRef } from "react";

/**
 * The strip a note shows for five seconds after "Mark as done" (DES-39): it overlays the top
 * of the body, under the header, and offers Undo. The timer and the saving belong to the note
 * window; this only draws the strip and takes focus, so Enter or Space undoes at once.
 */
export function DoneStrip({ onUndo }: { onUndo: () => void }) {
  const undo = useRef<HTMLButtonElement>(null);
  useEffect(() => undo.current?.focus(), []);
  return (
    <div className="dn-done-strip">
      <span role="status">Marked done</span>
      <button ref={undo} type="button" onClick={onUndo}>
        Undo
      </button>
    </div>
  );
}
