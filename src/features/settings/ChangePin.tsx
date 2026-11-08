import { useEffect, useId, useRef, useState } from "react";
import { CommandError, commands } from "../../ipc/commands";
import type { PinCheck } from "../../types/note";
import { PinPad } from "../privacy/PinPad";
import { Dialog } from "./Dialog";
import { holding, useSettingsHold } from "./hold";
import { PINS_DIFFER } from "./PinSetup";

type Step = 1 | 2 | 3;

const NOT_CHECKED = "Your PIN was not checked. Enter it again.";

const TITLES: Record<Step, string> = {
  1: "Enter your current PIN",
  2: "Choose a new PIN",
  3: "Confirm your new PIN",
};

/**
 * Change PIN (design "Change PIN · 1 of 3"): current PIN, new PIN, confirm, in an
 * S3-style dialog. `change_pin` checks both at the end; a wrong current PIN goes back
 * to step one and keeps the new PIN, so only the current one is typed again.
 * PINs wait in refs until the change is done (the new one is kept for another try
 * after a wrong current PIN or an error) and are dropped when the dialog closes.
 */
export function ChangePin({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const titleId = useId();
  const [step, setStep] = useState<Step>(1);
  const [notice, setNotice] = useState<PinCheck | string | null>(null);
  /** A wrong current PIN sent the person back to step one with the new PIN kept. */
  const [keepsNew, setKeepsNew] = useState(false);
  /** `change_pin` is running: the dialog cannot close until it has answered. */
  const [busy, setBusy] = useState(false);
  const hold = useSettingsHold();
  const current = useRef<string | null>(null);
  const first = useRef<string | null>(null);
  /** The confirmed new PIN, kept while the current one is typed again. */
  const next = useRef<string | null>(null);

  useEffect(
    () => () => {
      current.current = null;
      first.current = null;
      next.current = null;
    },
    [],
  );

  const go = (to: Step, why: PinCheck | string | null = null) => {
    setNotice(why);
    setStep(to);
  };

  async function change(currentPin: string, newPin: string): Promise<PinCheck | null> {
    let result: PinCheck;
    setBusy(true);
    try {
      result = await holding(hold, () => commands.changePin(currentPin, newPin));
    } catch (e) {
      if (e instanceof CommandError && e.code === "validation") {
        // A new PIN that is too easy: choose it again (the current one is kept).
        first.current = null;
        next.current = null;
        setKeepsNew(false);
        current.current = currentPin;
        go(2, e.message);
        return null;
      }
      // Anything else changed nothing: try again from the current PIN, the new one kept
      // (from the confirm step, typing the new PIN again could never match).
      current.current = null;
      next.current = newPin;
      setKeepsNew(true);
      if (step === 1) throw e;
      go(1, e instanceof Error ? e.message : String(e));
      return null;
    } finally {
      setBusy(false);
    }
    if (result.kind === "ok") {
      current.current = null;
      next.current = null;
      return result; // PinPad calls onUnlocked → onDone
    }
    // Wrong current PIN (or a wait): type it again; the new PIN is kept.
    current.current = null;
    next.current = newPin;
    setKeepsNew(true);
    if (step === 1) return result;
    // A wait that ended as it was read: nothing was checked, so nothing was wrong.
    go(1, result.kind === "waiting" && result.waitSecs <= 0 ? NOT_CHECKED : result);
    return null;
  }

  async function enterCurrent(pin: string) {
    if (next.current) return change(pin, next.current);
    current.current = pin;
    go(2);
    return null;
  }

  async function chooseNew(pin: string) {
    first.current = pin;
    go(3);
    return null;
  }

  async function confirmNew(pin: string) {
    if (pin !== first.current) throw new Error(PINS_DIFFER);
    first.current = null;
    return change(current.current ?? "", pin);
  }

  return (
    <Dialog titleId={titleId} onEscape={busy ? undefined : onCancel} className="dn-pin-dialog">
      <span className="dn-step-label">Change PIN · {step} of 3</span>
      <div id={titleId} className="dn-modal-title">
        {TITLES[step]}
      </div>
      <PinPad
        key={step}
        variant="app"
        label={TITLES[step]}
        check={step === 1 ? enterCurrent : step === 2 ? chooseNew : confirmNew}
        notice={notice}
        onUnlocked={onDone}
      />
      {step === 1 && !keepsNew && <div className="dn-step-hint">Then choose and confirm the new one.</div>}
      <div className="dn-modal-actions">
        <button type="button" className="dn-btn-outline is-large" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </Dialog>
  );
}
