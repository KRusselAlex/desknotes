import { useEffect, useRef, useState } from "react";
import { Icon } from "../../components/Icon";
import { imageProblemText, type ImageProblem } from "./imageInput";

/** How long the message stays when it is not closed (design §2.5). */
export const IMAGE_MESSAGE_MS = 8000;

/**
 * Why an image was not added, in the "Not saved" bar's look above the format bar. Closes
 * on × or by itself after 8 s. Give it a new `key` for each problem so a new one replaces
 * the old one and its time starts again.
 */
export function ImageMessage({ problem, onDismiss }: { problem: ImageProblem; onDismiss: () => void }) {
  const [open, setOpen] = useState(true);
  // Read by the timer, so the note re-rendering (typing) never restarts the 8 s.
  const dismiss = useRef(onDismiss);
  useEffect(() => {
    dismiss.current = onDismiss;
  });

  useEffect(() => {
    if (!open) return;
    const timer = setTimeout(() => {
      setOpen(false);
      dismiss.current();
    }, IMAGE_MESSAGE_MS);
    return () => clearTimeout(timer);
  }, [open]);

  if (!open) return null;
  return (
    <div className="dn-save-error dn-image-message" role="alert">
      <Icon name="alert" />
      <span>{imageProblemText(problem)}</span>
      <button
        type="button"
        className="dn-message-close"
        aria-label="Dismiss"
        title="Dismiss"
        // Keeps the editor focused, so the format bar the message sits above stays.
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => {
          setOpen(false);
          onDismiss();
        }}
      >
        <Icon name="close" size={14} />
      </button>
    </div>
  );
}
