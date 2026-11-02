import { useEffect, useRef, useState } from "react";
import { commands } from "../../ipc/commands";
import type { ToggleShortcut } from "../../types/note";
import { accelFromKey } from "./shortcut";

const SUGGESTED = { accel: "<Control><Alt>n", label: "Ctrl+Alt+N" };
const UNAVAILABLE: ToggleShortcut = { available: false, binding: null, label: null };

/**
 * "Show / hide all notes" row (design S2) and its set-up dialog (DES-27; drawn by
 * DeskNotes from the S2 row and the S3 confirmation, as the owner asked). DeskNotes
 * adds a GNOME custom shortcut only when the person presses "Set shortcut".
 */
export function ShortcutRow() {
  const [shortcut, setShortcut] = useState<ToggleShortcut | null>(null);
  const [open, setOpen] = useState(false);
  // Focus goes back to "Set up…" / "Change" when the dialog closes.
  const openerRef = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);

  useEffect(() => {
    commands.getToggleShortcut().then(setShortcut, () => setShortcut(UNAVAILABLE));
  }, []);

  useEffect(() => {
    if (wasOpen.current && !open) openerRef.current?.focus();
    wasOpen.current = open;
  }, [open]);

  if (!shortcut) return null;
  return (
    <>
      <div className="dn-card-sep" />
      <div className="dn-card-row">
        <div className="dn-card-label">Show / hide all notes</div>
        {!shortcut.available ? (
          <span className="dn-muted">Not available on this desktop</span>
        ) : shortcut.label ? (
          <>
            <span className="dn-key-pill">{shortcut.label}</span>
            <button ref={openerRef} type="button" className="dn-btn-link" onClick={() => setOpen(true)}>
              Change
            </button>
          </>
        ) : (
          <>
            <span className="dn-muted">Not set up</span>
            <button ref={openerRef} type="button" className="dn-btn-link" onClick={() => setOpen(true)}>
              Set up…
            </button>
          </>
        )}
      </div>
      {open && <ShortcutDialog current={shortcut} onChanged={setShortcut} onClose={() => setOpen(false)} />}
    </>
  );
}

function ShortcutDialog({
  current,
  onChanged,
  onClose,
}: {
  current: ToggleShortcut;
  onChanged: (s: ToggleShortcut) => void;
  onClose: () => void;
}) {
  const [captured, setCaptured] = useState(
    current.binding && current.label ? { accel: current.binding, label: current.label } : SUGGESTED,
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fieldRef = useRef<HTMLInputElement>(null);
  useEffect(() => fieldRef.current?.focus(), []);

  async function run(action: () => Promise<ToggleShortcut>) {
    setBusy(true);
    try {
      onChanged(await action());
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const unchanged = captured.accel === current.binding;

  /** Tab and Shift+Tab cycle inside the dialog instead of reaching the page behind. */
  function keepFocusInside(e: React.KeyboardEvent<HTMLDivElement>) {
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
    <div className="dn-modal-backdrop" onKeyDown={(e) => e.key === "Escape" && onClose()}>
      <div
        className="dn-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="shortcut-title"
        aria-describedby="shortcut-text"
        onKeyDown={keepFocusInside}
      >
        <div id="shortcut-title" className="dn-modal-title">
          Show / hide all notes
        </div>
        <div id="shortcut-text" className="dn-modal-text">
          DeskNotes will add this shortcut to GNOME’s keyboard settings, so it works in every app. You can remove
          it here or in GNOME Settings → Keyboard.
        </div>
        <input
          ref={fieldRef}
          className="dn-key-capture"
          readOnly
          aria-label="Shortcut"
          aria-invalid={error !== null}
          aria-describedby={error ? "shortcut-error" : "shortcut-hint"}
          value={captured.label}
          onKeyDown={(e) => {
            const noCommand = !e.ctrlKey && !e.altKey && !e.metaKey;
            if (noCommand && e.key === "Tab") return; // Tab / Shift+Tab move focus
            if (noCommand && !e.shiftKey && e.key === "Escape") return; // closes the dialog
            e.preventDefault();
            const result = accelFromKey(e);
            if (!result) return;
            if ("error" in result) {
              setError(result.error);
            } else {
              setCaptured(result);
              setError(null);
            }
          }}
        />
        {error ? (
          <div id="shortcut-error" className="dn-field-error" role="alert">
            {error}
          </div>
        ) : (
          <div id="shortcut-hint" className="dn-muted dn-small">
            Click the field, then press the keys you want.
          </div>
        )}
        <div className="dn-modal-actions">
          {current.binding && (
            <button
              type="button"
              className="dn-btn-link is-danger"
              disabled={busy}
              onClick={() => void run(() => commands.removeToggleShortcut())}
            >
              Remove shortcut
            </button>
          )}
          <button type="button" className="dn-btn-outline is-large" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="dn-btn-accent is-large"
            disabled={busy || unchanged}
            onClick={() => void run(() => commands.setToggleShortcut(captured.accel))}
          >
            <span>Set shortcut</span>
          </button>
        </div>
      </div>
    </div>
  );
}
