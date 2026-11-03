import { useEffect, useId, useState } from "react";
import { Icon } from "../../components/Icon";
import { Segmented } from "../../components/Segmented";
import { Switch } from "../../components/Switch";
import { commands } from "../../ipc/commands";
import { onPrivacyChanged } from "../../ipc/events";
import type { PinCheck, PrivacyStatus, RecoveryMethod } from "../../types/note";
import { PinPad } from "../privacy/PinPad";
import { ChangePin } from "./ChangePin";
import { Dialog } from "./Dialog";
import { holding, useIssuingHold, useSettingsHold } from "./hold";
import { PinSetup, RECOVERY_OPTIONS } from "./PinSetup";
import { RecoveryCode } from "./RecoveryCode";

/** "Lock after inactivity" choices, in minutes (Rust `set_lock_after`). */
export const LOCK_AFTER_MINUTES = [1, 5, 10, 15] as const;
const LOCK_AFTER_OPTIONS = LOCK_AFTER_MINUTES.map((m) => ({ value: m, label: `${m} min` }));

type Modal =
  /** Asked for by another window (`open_settings("privacy-new-pin")`): opens once the status is known. */
  | { kind: "newPin" }
  | { kind: "setup" }
  | { kind: "change" }
  | { kind: "turnOff" }
  | { kind: "method"; method: RecoveryMethod }
  | { kind: "newCode" };

/** The "If I forget my PIN" choice in effect (PINs set before it existed follow the old rule). */
export function recoveryMethodOf(status: PrivacyStatus): RecoveryMethod {
  return status.recoveryMethod ?? (status.recovery === "system" ? "system" : "code");
}

/**
 * Settings → Privacy (design S1 "Privacy", wording D10, "If I forget my PIN" D14).
 * Every change that needs the PIN asks for it in a dialog; PINs and recovery codes
 * live only in those dialogs and are dropped when they close.
 */
export function PrivacyPane({
  startNewPin = false,
  onNewPinStarted,
}: {
  /** Open "choose a new PIN" (after a forgotten-PIN proof). */
  startNewPin?: boolean;
  onNewPinStarted?: () => void;
}) {
  const [status, setStatus] = useState<PrivacyStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [modal, setModal] = useState<Modal | null>(startNewPin ? { kind: "newPin" } : null);

  useEffect(() => {
    if (startNewPin) onNewPinStarted?.();
  }, [startNewPin, onNewPinStarted]);

  useEffect(() => {
    let live = true;
    const load = () =>
      commands.privacyStatus().then(
        (s) => live && setStatus(s),
        (e: Error) => live && setError(e.message),
      );
    void load();
    const unlisten = onPrivacyChanged(() => void load());
    return () => {
      live = false;
      void unlisten.then((f) => f());
    };
  }, []);

  async function reload() {
    try {
      setStatus(await commands.privacyStatus());
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function run(action: () => Promise<void>) {
    setNotice(null);
    try {
      await action();
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const open = (next: Modal) => {
    setNotice(null);
    setModal(next);
  };

  const close = () => {
    setModal(null);
    void reload();
  };

  if (!status) {
    return (
      <>
        <h1>Privacy</h1>
        {error && <ErrorBanner text={error} />}
      </>
    );
  }

  const method = recoveryMethodOf(status);
  const methodOptions = RECOVERY_OPTIONS.filter((o) => o.value === "code" || status.systemAvailable || method === "system");
  const shown = modal?.kind === "newPin" ? (status.enabled ? "chooseNew" : "setup") : modal?.kind;

  return (
    <>
      <h1>Privacy</h1>
      {error && <ErrorBanner text={error} />}
      <div className="dn-card">
        <div className="dn-card-row">
          <div className="dn-card-text">
            <div className="dn-card-label">Lock private notes with a PIN</div>
            <div className="dn-card-sub">Hides the text of private notes in every window until unlocked.</div>
          </div>
          <Switch
            label="Lock private notes with a PIN"
            checked={status.enabled}
            onChange={(on) => open({ kind: on ? "setup" : "turnOff" })}
          />
        </div>
        {status.enabled && (
          <>
            <div className="dn-card-sep" />
            <div className="dn-card-row">
              <div className="dn-card-label">Lock after inactivity</div>
              <Segmented
                label="Lock after inactivity"
                options={LOCK_AFTER_OPTIONS}
                value={status.lockAfterMinutes}
                onChange={(m) =>
                  void run(async () => {
                    await commands.setLockAfter(m);
                    setStatus((s) => (s ? { ...s, lockAfterMinutes: m } : s));
                  })
                }
              />
            </div>
            <div className="dn-card-sep" />
            <div className="dn-card-row is-wrap">
              <div className="dn-card-label">If I forget my PIN</div>
              <Segmented
                label="If I forget my PIN"
                options={methodOptions}
                value={method}
                onChange={(m) => open({ kind: "method", method: m })}
              />
            </div>
            <div className="dn-card-sep" />
            <div className="dn-card-row dn-privacy-actions">
              <button type="button" className="dn-btn-accent is-small" onClick={() => void run(() => commands.lockNow())}>
                <Icon name="lock" size={15} />
                <span>Lock now</span>
              </button>
              <button type="button" className="dn-btn-outline is-medium" onClick={() => open({ kind: "change" })}>
                Change PIN…
              </button>
              {method === "code" && (
                <button type="button" className="dn-btn-outline is-medium" onClick={() => open({ kind: "newCode" })}>
                  New recovery code…
                </button>
              )}
            </div>
          </>
        )}
      </div>
      {notice && (
        <div className="dn-notice-ok" role="status">
          <Icon name="check" size={16} />
          <span>{notice}</span>
        </div>
      )}
      <div className="dn-privacy-note">
        <Icon name="info" size={16} />
        <span>The lock hides your notes from people looking at your screen. It does not encrypt the notes file.</span>
      </div>

      {(shown === "setup" || shown === "chooseNew") && (
        <PinSetup mode={shown} status={status} onDone={close} onCancel={() => setModal(null)} />
      )}
      {shown === "change" && (
        <ChangePin
          onDone={() => {
            close();
            setNotice("Your PIN was changed.");
          }}
          onCancel={() => setModal(null)}
        />
      )}
      {shown === "turnOff" && (
        <PinDialog
          title="Turn off the lock?"
          text="Enter your PIN. Notes you made private keep that mark, but nothing is locked until you set a PIN again."
          check={(pin) => commands.turnOffLock(pin)}
          onDone={close}
          onCancel={() => setModal(null)}
        />
      )}
      {modal?.kind === "method" && (
        <PinDialog
          title={modal.method === "system" ? "Use my computer password" : "Use a recovery code"}
          text={
            modal.method === "system"
              ? "Enter your PIN. If you forget it, your computer password will unlock private notes, and your recovery code will stop working."
              : "Enter your PIN. You will get a new recovery code, and your computer password will no longer unlock private notes."
          }
          withCode={async (pin) => commands.setRecoveryMethod(pin, modal.method)}
          onDone={close}
          onCancel={() => setModal(null)}
        />
      )}
      {shown === "newCode" && (
        <PinDialog
          title="New recovery code"
          text="Enter your PIN. Your old recovery code will stop working."
          replaced
          withCode={async (pin) => commands.setRecoveryMethod(pin, "code")}
          onDone={close}
          onCancel={() => setModal(null)}
        />
      )}
    </>
  );
}

function ErrorBanner({ text }: { text: string }) {
  return (
    <div className="dn-banner-error" role="alert">
      <Icon name="alert" size={18} />
      <span>{text}</span>
    </div>
  );
}

/**
 * Asks for the current PIN once, in an S3-style dialog. `check` answers with a
 * `PinCheck`; `withCode` also returns a recovery code to show once (L5 presentation).
 */
function PinDialog({
  title,
  text,
  check,
  withCode,
  replaced,
  onDone,
  onCancel,
}: {
  title: string;
  text: string;
  check?: (pin: string) => Promise<PinCheck>;
  withCode?: (pin: string) => Promise<{ check: PinCheck; recoveryCode: string | null }>;
  replaced?: boolean;
  onDone: () => void;
  onCancel: () => void;
}) {
  const titleId = useId();
  const [code, setCode] = useState<string | null>(null);
  /** The PIN is being checked: the change (and any new code) may already be committed,
   * so the dialog cannot close until the answer is in. */
  const [busy, setBusy] = useState(false);
  const hold = useSettingsHold();
  const issuing = useIssuingHold(code);

  async function checkPin(pin: string): Promise<PinCheck | null> {
    setBusy(true);
    try {
      if (check) return await holding(hold, () => check(pin));
      const result = await issuing(
        () => withCode!(pin),
        (r) => r.check.kind === "ok" && r.recoveryCode !== null,
      );
      if (result.check.kind === "ok" && result.recoveryCode) {
        setCode(result.recoveryCode);
        return null;
      }
      return result.check;
    } finally {
      setBusy(false);
    }
  }

  if (code) {
    return (
      <Dialog titleId={titleId} className="dn-pin-dialog">
        <RecoveryCode
          code={code}
          titleId={titleId}
          replaced={replaced}
          doneLabel="Done"
          onDone={() => {
            setCode(null);
            onDone();
          }}
        />
      </Dialog>
    );
  }

  return (
    <Dialog titleId={titleId} onEscape={busy ? undefined : onCancel} className="dn-pin-dialog">
      <div id={titleId} className="dn-modal-title">
        {title}
      </div>
      <div className="dn-modal-text">{text}</div>
      <PinPad variant="app" label="Your PIN" check={checkPin} onUnlocked={onDone} />
      <div className="dn-modal-actions">
        <button type="button" className="dn-btn-outline is-large" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </Dialog>
  );
}
