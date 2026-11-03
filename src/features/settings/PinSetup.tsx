import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Segmented } from "../../components/Segmented";
import { CommandError, commands } from "../../ipc/commands";
import type { PrivacyStatus, RecoveryMethod } from "../../types/note";
import { PinPad } from "../privacy/PinPad";
import { Dialog } from "./Dialog";
import { useIssuingHold } from "./hold";
import { RecoveryCode } from "./RecoveryCode";

export const PINS_DIFFER = "The PINs don't match. Enter it again.";

export const RECOVERY_OPTIONS: readonly { value: RecoveryMethod; label: string }[] = [
  { value: "system", label: "Use my computer password" },
  { value: "code", label: "Use a recovery code" },
];

export interface PinSetupProps {
  /** "setup": the first PIN (`setup_pin`). "chooseNew": a new PIN after a forgotten-PIN
   * proof (`choose_new_pin`), which keeps the "If I forget my PIN" choice. */
  mode: "setup" | "chooseNew";
  status: Pick<PrivacyStatus, "systemAvailable" | "recovery">;
  /** The PIN is stored and any recovery code was acknowledged. */
  onDone: () => void;
  /** Closed before a PIN was stored. */
  onCancel: () => void;
}

type Step = "choose" | "confirm" | "code";

/**
 * Choose, confirm and, where the recovery code is the way back, save the code
 * (design "Confirm PIN mismatch · Change PIN" and "Set up PIN · step 3, recovery code"),
 * in an S3-style dialog. The first PIN waits in a ref until it is confirmed.
 */
export function PinSetup({ mode, status, onDone, onCancel }: PinSetupProps) {
  const titleId = useId();
  const [method, setMethod] = useState<RecoveryMethod>(status.systemAvailable ? "system" : "code");
  const [step, setStep] = useState<Step>("choose");
  const [notice, setNotice] = useState<string | null>(null);
  const [code, setCode] = useState<string | null>(null);
  /** `setup_pin` / `choose_new_pin` is running: it may issue a code, so the dialog cannot close. */
  const [busy, setBusy] = useState(false);
  const first = useRef<string | null>(null);
  const issuing = useIssuingHold(code);

  useEffect(
    () => () => {
      first.current = null;
    },
    [],
  );

  const withCode = mode === "setup" ? method === "code" : status.recovery !== "system";
  const total = withCode ? 3 : 2;
  const flow = mode === "setup" ? "Set up lock" : "New PIN";

  const choose = useCallback(async (pin: string) => {
    first.current = pin;
    setNotice(null);
    setStep("confirm");
    return null;
  }, []);

  const confirm = useCallback(
    async (pin: string) => {
      if (pin !== first.current) throw new Error(PINS_DIFFER);
      setBusy(true);
      try {
        const result = await issuing(
          () => (mode === "setup" ? commands.setupPin(pin, method) : commands.chooseNewPin(pin)),
          (r) => r.recoveryCode !== null,
        );
        first.current = null;
        if (result.recoveryCode) {
          setCode(result.recoveryCode);
          setStep("code");
        } else onDone();
      } catch (e) {
        // A PIN that is too easy is chosen again from step one.
        if (!(e instanceof CommandError && e.code === "validation")) throw e;
        first.current = null;
        setNotice(e.message);
        setStep("choose");
      } finally {
        setBusy(false);
      }
      return null;
    },
    [issuing, method, mode, onDone],
  );

  const finish = () => {
    setCode(null);
    onDone();
  };

  const cancellable = step !== "code" && !busy;

  return (
    <Dialog titleId={titleId} onEscape={cancellable ? onCancel : undefined} className="dn-pin-dialog">
      {step === "code" && code ? (
        <RecoveryCode
          code={code}
          titleId={titleId}
          steps
          doneLabel={mode === "setup" ? "Turn on lock" : "Done"}
          onDone={finish}
        />
      ) : (
        <>
          <span className="dn-step-label">
            {flow} · {step === "choose" ? 1 : 2} of {total}
          </span>
          <div id={titleId} className="dn-modal-title">
            {step === "choose"
              ? mode === "setup"
                ? "Choose a PIN"
                : "Choose a new PIN"
              : mode === "setup"
                ? "Confirm your PIN"
                : "Confirm your new PIN"}
          </div>
          <PinPad
            key={step}
            variant="app"
            label={step === "choose" ? "New PIN" : "Confirm PIN"}
            check={step === "choose" ? choose : confirm}
            notice={step === "choose" ? notice : null}
            onUnlocked={() => undefined}
          />
          {mode === "setup" && step === "choose" && status.systemAvailable && (
            <div className="dn-pin-method">
              <span className="dn-field-label">If I forget my PIN</span>
              <Segmented label="If I forget my PIN" options={RECOVERY_OPTIONS} value={method} onChange={setMethod} />
            </div>
          )}
          <div className="dn-modal-actions">
            <button type="button" className="dn-btn-outline is-large" disabled={busy} onClick={onCancel}>
              Cancel
            </button>
          </div>
        </>
      )}
    </Dialog>
  );
}
