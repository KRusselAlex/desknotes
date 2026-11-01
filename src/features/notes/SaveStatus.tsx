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
export function SaveError({ onRetry, reason }: { onRetry: () => void; reason?: string }) {
  return (
    <div className="dn-save-error" role="alert">
      <Icon name="alert" />
      <span title={reason ? `Reason: ${reason}` : undefined}>Not saved. Your text is kept in this window.</span>
      <button type="button" onClick={onRetry}>
        Retry
      </button>
    </div>
  );
}
