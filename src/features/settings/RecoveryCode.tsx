import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "../../components/Icon";
import { useHoldWhile } from "./hold";

/**
 * A recovery code shown once (design "Set up PIN · step 3, recovery code"): the six
 * groups, Copy, Print and "I've written it down", which the done button waits for.
 * The code is only on screen; it is copied only when Copy is pressed, and Print
 * prints nothing but the code.
 */
export function RecoveryCode({
  code,
  titleId,
  steps,
  replaced,
  doneLabel,
  onDone,
}: {
  /** Dashed code from the native side, e.g. "K7QD-M2XP-…". */
  code: string;
  /** Id for the title, so the dialog can be named by it. */
  titleId: string;
  /** Show the set-up steps above the title (choose, confirm, recovery code). */
  steps?: boolean;
  /** An older code existed and stops working now. */
  replaced?: boolean;
  doneLabel: string;
  onDone: () => void;
}) {
  const [writtenDown, setWrittenDown] = useState(false);
  const [copied, setCopied] = useState<"no" | "yes" | "failed">("no");
  const groups = code.split("-");
  // Settings must not switch section or remount the pane while the code is shown (R25).
  useHoldWhile(true);

  useEffect(() => {
    if (copied !== "yes") return;
    const timer = setTimeout(() => setCopied("no"), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  function copy() {
    navigator.clipboard.writeText(code).then(
      () => setCopied("yes"),
      () => setCopied("failed"),
    );
  }

  return (
    <div className="dn-recovery">
      {steps && (
        <div className="dn-steps">
          <span className="dn-step is-done">
            <Icon name="check" size={11} stroke={3} />
            Choose PIN
          </span>
          <span className="dn-step is-done">
            <Icon name="check" size={11} stroke={3} />
            Confirm PIN
          </span>
          <span className="dn-step is-current" aria-current="step">
            3 · Recovery code
          </span>
        </div>
      )}
      <div id={titleId} className="dn-recovery-title">
        Save your recovery code
      </div>
      <div className="dn-modal-text">
        This is the only way to unlock your private notes if you forget your PIN. It is shown once.
        {replaced && " Your old recovery code no longer works."}
      </div>
      <div className="dn-recovery-code" role="group" aria-label="Recovery code">
        {groups.map((g, i) => (
          <span key={i}>{g}</span>
        ))}
      </div>
      <div className="dn-button-row">
        <button type="button" className="dn-btn-outline is-code" onClick={copy}>
          <Icon name={copied === "yes" ? "check" : "copy"} size={15} />
          {copied === "yes" ? "Copied" : "Copy"}
        </button>
        <button type="button" className="dn-btn-outline is-code" onClick={() => window.print()}>
          <Icon name="printer" size={15} />
          Print
        </button>
      </div>
      {copied === "failed" && (
        <div className="dn-field-error" role="alert">
          The code could not be copied. Write it down or print it instead.
        </div>
      )}
      <label className="dn-check">
        <input type="checkbox" checked={writtenDown} onChange={(e) => setWrittenDown(e.target.checked)} />
        <span className="dn-check-box" aria-hidden="true">
          {writtenDown && <Icon name="check" size={13} stroke={3} />}
        </span>
        I've written it down
      </label>
      <div className="dn-modal-actions">
        <button type="button" className="dn-btn-accent is-large" disabled={!writtenDown} onClick={onDone}>
          <span>{doneLabel}</span>
        </button>
      </div>
      {createPortal(
        <div className="dn-print-only" aria-hidden="true">
          <div>DeskNotes recovery code</div>
          <div className="dn-print-code">{code}</div>
        </div>,
        document.body,
      )}
    </div>
  );
}
