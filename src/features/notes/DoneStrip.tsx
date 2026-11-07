import { useEffect, useRef } from "react";

/**
 * The strip a note shows for five seconds with Undo: after "Mark as done" (DES-39), with the reason
 * when automation rule 1 marked it done, or after rule 2 unticked its checklist (DES-42). It overlays
 * the top of the body, under the header. The timer and the saving belong to the note window; this
 * only draws the strip and, unless told not to, takes focus, so Enter or Space undoes at once.
 * Undo is described by the text, so a screen reader reads "Undo, Marked done" even if it misses the
 * live region (a region that appears already filled is not always announced).
 */
export function DoneStrip({
  text = "Marked done",
  takeFocus = true,
  onUndo,
}: {
  text?: string;
  /** False when the strip comes on its own (a reminder), so text being typed keeps the focus. */
  takeFocus?: boolean;
  onUndo: () => void;
}) {
  const undo = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (takeFocus) undo.current?.focus();
  }, [takeFocus]);
  return (
    <div className="dn-done-strip">
      <span id="dn-done-text" role="status">
        {text}
      </span>
      <button ref={undo} type="button" aria-describedby="dn-done-text" onClick={onUndo}>
        Undo
      </button>
    </div>
  );
}
