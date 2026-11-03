import { useId, useState } from "react";
import { Dialog } from "../settings/Dialog";
import { ForgotPin } from "./ForgotPin";
import { PinPad } from "./PinPad";

export interface UnlockDialogProps {
  title: string;
  text: string;
  /** The PIN was right: every private note is unlocked. */
  onUnlocked: () => void;
  /** Unlocked through "Forgot your PIN?" (Settings was asked to choose a new PIN). Default: `onUnlocked`. */
  onProved?: () => void;
  onCancel: () => void;
}

/**
 * Asks for the PIN to unlock private notes before an action that needs them unlocked
 * (R11 backup export and restore, R20 a refused save), in an S3-style dialog.
 * "Forgot your PIN?" leads to the forgotten-PIN screens in the same window.
 */
export function UnlockDialog({ title, text, onUnlocked, onProved = onUnlocked, onCancel }: UnlockDialogProps) {
  const titleId = useId();
  const [forgot, setForgot] = useState(false);

  if (forgot) return <ForgotPin onClose={() => setForgot(false)} onProved={onProved} />;

  return (
    <Dialog titleId={titleId} onEscape={onCancel} className="dn-pin-dialog dn-forgot">
      <div id={titleId} className="dn-modal-title">
        {title}
      </div>
      <div className="dn-modal-text">{text}</div>
      <PinPad variant="app" label="Your PIN" onUnlocked={onUnlocked} onForgot={() => setForgot(true)} />
      <div className="dn-modal-actions">
        <button type="button" className="dn-btn-outline is-large" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </Dialog>
  );
}
