import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { PRIVATE_FALLBACK_LABEL, PRIVATE_LABEL_MAX_CHARS } from "../../types/note";

export interface PrivateLabelDialogProps {
  /** "make": the note is about to become private; "rename": change its label. */
  mode: "make" | "rename";
  /** Current label ("" when none). */
  initialLabel: string;
  /** Saves the trimmed label ("" for none). A rejection's message is shown in the dialog. */
  onConfirm: (label: string) => Promise<void>;
  onCancel: () => void;
}

/**
 * Optional label shown on a private note while it is locked (design D2), in the
 * S3 modal style. The label is checked again in Rust (≤ 40 characters, plain text).
 */
export function PrivateLabelDialog({ mode, initialLabel, onConfirm, onCancel }: PrivateLabelDialogProps) {
  const [label, setLabel] = useState(initialLabel);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fieldRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    // Next frame: after a focus already queued for it (the note editor focuses that way).
    const frame = requestAnimationFrame(() => {
      fieldRef.current?.focus();
      fieldRef.current?.select();
    });
    return () => cancelAnimationFrame(frame);
  }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await onConfirm(label.trim());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  /** Tab and Shift+Tab cycle inside the dialog; Escape cancels. */
  function onKeyDown(e: KeyboardEvent<HTMLFormElement>) {
    if (e.key === "Escape") {
      e.stopPropagation();
      onCancel();
      return;
    }
    if (e.key !== "Tab") return;
    const items = [...e.currentTarget.querySelectorAll<HTMLElement>("input, button:not(:disabled)")];
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last?.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first?.focus();
    }
  }

  return (
    <div className="dn-modal-backdrop">
      <form
        className="dn-modal dn-private-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="private-title"
        aria-describedby="private-text"
        onKeyDown={onKeyDown}
        onSubmit={(e) => void submit(e)}
      >
        <div id="private-title" className="dn-modal-title">
          {mode === "make" ? "Make this note private" : "Private note label"}
        </div>
        <div id="private-text" className="dn-modal-text">
          While private notes are locked, this note shows only its colour and this label.
        </div>
        <label className="dn-field-label" htmlFor="private-label">
          Label (optional)
        </label>
        <input
          ref={fieldRef}
          id="private-label"
          className="dn-text-field"
          value={label}
          maxLength={PRIVATE_LABEL_MAX_CHARS}
          placeholder={PRIVATE_FALLBACK_LABEL}
          autoComplete="off"
          spellCheck={false}
          aria-invalid={error !== null}
          aria-describedby={error ? "private-error" : undefined}
          onChange={(e) => setLabel(e.target.value)}
        />
        {error && (
          <div id="private-error" className="dn-field-error" role="alert">
            {error}
          </div>
        )}
        <div className="dn-modal-actions">
          <button type="button" className="dn-btn-outline is-large" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="dn-btn-accent is-large" disabled={busy}>
            <span>{mode === "make" ? "Make private" : "Save"}</span>
          </button>
        </div>
      </form>
    </div>
  );
}
