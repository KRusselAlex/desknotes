import { Icon } from "../../components/Icon";
import type { SaveState } from "./autosave";

/** Discreet indicator in the bottom-right of the body (design N2/N3). */
export function SaveIndicator({ state, editing }: { state: SaveState; editing: boolean }) {
  if (state === "error") return null;
  const text = state === "saved" ? (editing ? "Saved" : "") : "Saving…";
  return (
    <span className="dn-save-indicator" aria-live="polite">
      {text}
    </span>
  );
}

/**
 * Inline message when a save failed (design N6). Text stays editable.
 * `reason` (the core's message, never note text) is shown on hover for bug reports.
 */
export function SaveError({
  onRetry,
  onUnlock,
  reason,
}: {
  onRetry: () => void;
  /** The save was refused because private notes are locked: unlock here, then it is saved (R20). */
  onUnlock?: () => void;
  reason?: string;
}) {
  return (
    <div className="dn-save-error" role="alert">
      <Icon name="alert" />
      <span title={reason ? `Reason: ${reason}` : undefined}>Not saved. Your text is kept in this window.</span>
      {onUnlock ? (
        // Keeps focus in the editor on press: its blur would retry the save, hiding this bar
        // (and the button) before the click lands.
        <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={onUnlock}>
          Unlock to save
        </button>
      ) : (
        <button type="button" onClick={onRetry}>
          Retry
        </button>
      )}
    </div>
  );
}

/** Why an action from the note's menu was refused (R21), in the "Not saved" bar's style. */
export function NoteNotice({ text, onDismiss }: { text: string; onDismiss: () => void }) {
  return (
    <div className="dn-save-error" role="alert">
      <Icon name="alert" />
      <span>{text}</span>
      <button type="button" onClick={onDismiss}>
        OK
      </button>
    </div>
  );
}
