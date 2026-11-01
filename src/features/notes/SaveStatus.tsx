import type { SaveState } from "./autosave";

export function SaveStatus({ state, onRetry }: { state: SaveState; onRetry: () => void }) {
  if (state === "error") {
    return (
      <div className="save-status save-error" role="alert">
        Not saved. Your text is kept in this window.{" "}
        <button type="button" onClick={onRetry}>
          Retry
        </button>
      </div>
    );
  }
  const text = { saved: "Saved", pending: "Editing…", saving: "Saving…" }[state];
  return (
    <div className="save-status" aria-live="polite">
      {text}
    </div>
  );
}
