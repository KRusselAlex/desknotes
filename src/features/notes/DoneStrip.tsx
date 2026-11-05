import { useEffect, useRef } from "react";

/**
 * The strip a note shows for five seconds after "Mark as done" (DES-39): it overlays the top
 * of the body, under the header, and offers Undo. The timer and the saving belong to the note
 * window; this only draws the strip and takes focus, so Enter or Space undoes at once.
 * Undo takes focus and is described by the text, so a screen reader reads "Undo, Marked done"
 * even if it misses the live region (a region that appears already filled is not always announced).
 */
export function DoneStrip({ onUndo }: { onUndo: () => void }) {
  const undo = useRef<HTMLButtonElement>(null);
  useEffect(() => undo.current?.focus(), []);
  return (
    <div className="dn-done-strip">
      <span id="dn-done-text" role="status">
        Marked done
      </span>
      <button ref={undo} type="button" aria-describedby="dn-done-text" onClick={onUndo}>
        Undo
      </button>
    </div>
  );
}
