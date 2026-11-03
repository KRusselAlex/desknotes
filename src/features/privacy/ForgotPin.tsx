import { useCallback, useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Icon } from "../../components/Icon";
import { commands } from "../../ipc/commands";
import type { PrivacyStatus } from "../../types/note";
import { Dialog } from "../settings/Dialog";
import { PinStatus, sentence, usePinMessage } from "./pinMessage";

/** A recovery code: 24 letters and digits, shown in 6 groups of 4 (Rust `RECOVERY_LEN`). */
export const RECOVERY_CODE_LENGTH = 24;
const GROUP = 4;

/** The code as typed, reduced to its letters and digits (upper case), at most 24. */
export function normalizeRecoveryCode(input: string): string {
  return input
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, RECOVERY_CODE_LENGTH);
}

/** "K7QDM2XP…" → "K7QD-M2XP-…", the form the code was shown in. */
function dashed(code: string): string {
  return (code.match(/.{1,4}/g) ?? []).join("-");
}

const messageOf = (e: unknown) => sentence(e instanceof Error ? e.message : String(e));

/**
 * After the proof: the lock is off and one new PIN may be chosen, in Settings only
 * (where a new recovery code may be shown), so Settings opens at "choose a new PIN".
 */
async function chooseNewPinInSettings(then: () => void) {
  await commands.openSettings("privacy-new-pin").catch(() => undefined);
  then();
}

export interface ForgotPinProps {
  /** Back to the PIN pad: cancelled or refused (and done, unless `onProved` is given). */
  onClose: () => void;
  /** The proof was accepted: private notes are unlocked and Settings was asked to choose a new PIN. */
  onProved?: () => void;
}

/**
 * "Forgot your PIN?" in the window where it was pressed, as an S3-style dialog. The way
 * back follows `privacy_status().recovery`: the computer (Ubuntu) password asked by the
 * system, the recovery code (design "Recovery code entry"), or, with neither, the last
 * resort `desknotes --reset-pin` explained. A successful proof unlocks private notes and
 * leads straight to choosing a new PIN (spec §4.6, §7).
 */
export function ForgotPin({ onClose, onProved = onClose }: ForgotPinProps) {
  const [route, setRoute] = useState<PrivacyStatus["recovery"] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    commands.privacyStatus().then(
      (s) => setRoute(s.recovery),
      (e: unknown) => setError(messageOf(e)),
    );
  }, []);

  if (error) {
    return (
      <Shell title="Forgot your PIN?" onEscape={onClose}>
        <ErrorLine text={error} />
        <Actions>
          <BackButton onClick={onClose} />
        </Actions>
      </Shell>
    );
  }
  if (route === "system") return <SystemProof onClose={onClose} onProved={onProved} />;
  if (route === "code") return <CodeEntry onClose={onClose} onProved={onProved} />;
  if (route === "none") return <LastResort onClose={onClose} />;
  return null; // asking which way back applies (a moment)
}

function Shell({
  title,
  onEscape,
  className,
  children,
}: {
  title: string;
  onEscape?: () => void;
  className?: string;
  children: ReactNode;
}) {
  const titleId = useId();
  return (
    <Dialog titleId={titleId} onEscape={onEscape} className={`dn-pin-dialog dn-forgot${className ? ` ${className}` : ""}`}>
      <div id={titleId} className="dn-modal-title">
        {title}
      </div>
      {children}
    </Dialog>
  );
}

function Actions({ children }: { children: ReactNode }) {
  return <div className="dn-modal-actions">{children}</div>;
}

function BackButton({ onClick, label = "Back to PIN" }: { onClick: () => void; label?: string }) {
  return (
    <button type="button" className="dn-btn-outline is-large" onClick={onClick}>
      {label}
    </button>
  );
}

function ErrorLine({ text }: { text: string }) {
  return (
    <div className="dn-field-error" role="alert">
      {text}
    </div>
  );
}

type SystemPhase = { kind: "asking" } | { kind: "refused" } | { kind: "error"; text: string };

/** The computer password, asked by the system's own dialog (polkit). Cancel or a wrong password changes nothing. */
function SystemProof({ onClose, onProved }: { onClose: () => void; onProved: () => void }) {
  const [phase, setPhase] = useState<SystemPhase>({ kind: "asking" });
  const asked = useRef(false);

  const ask = useCallback(async () => {
    try {
      if (await commands.forgotPinSystem()) await chooseNewPinInSettings(onProved);
      else setPhase({ kind: "refused" });
    } catch (e) {
      setPhase({ kind: "error", text: messageOf(e) });
    }
  }, [onProved]);

  useEffect(() => {
    if (asked.current) return; // once per "Forgot your PIN?", also under StrictMode
    asked.current = true;
    void ask();
  }, [ask]);

  if (phase.kind === "asking") {
    // The system dialog has its own Cancel; nothing here can stop it.
    return (
      <Shell title="Forgot your PIN?">
        <div className="dn-modal-text" role="status">
          Enter your computer password in the window that opens. Then you choose a new PIN.
        </div>
      </Shell>
    );
  }
  if (phase.kind === "refused") {
    return (
      <Shell title="Nothing was changed" onEscape={onClose}>
        <div className="dn-modal-text" role="status">
          The computer password was not given, so your PIN still unlocks private notes.
        </div>
        <Actions>
          <BackButton onClick={onClose} />
          <button type="button" className="dn-btn-accent is-large" onClick={() => {
              setPhase({ kind: "asking" });
              void ask();
            }}>
            <span>Try again</span>
          </button>
        </Actions>
      </Shell>
    );
  }
  return (
    <Shell title="Forgot your PIN?" onEscape={onClose}>
      <ErrorLine text={phase.text} />
      <Actions>
        <BackButton onClick={onClose} />
      </Actions>
    </Shell>
  );
}

/**
 * Design "Recovery code entry": the 24-character code in 6 groups of 4, dashes and
 * spaces added for you, not case-sensitive. A wrong code or a running wait is shown
 * like the PIN pad's (the wrong-PIN waits are shared). The code is sent once per
 * Continue and dropped when the dialog closes.
 */
function CodeEntry({ onClose, onProved }: { onClose: () => void; onProved: () => void }) {
  const hintId = useId();
  const [code, setCode] = useState("");
  const [focused, setFocused] = useState(false);
  const [checking, setChecking] = useState(false);
  const { message, show, showCheck, remaining, waiting } = usePinMessage();
  const inputRef = useRef<HTMLInputElement>(null);
  const complete = code.length === RECOVERY_CODE_LENGTH;

  useEffect(() => {
    // Next frame: after the dialog has taken focus for itself.
    const frame = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, []);

  async function submit(e?: FormEvent) {
    e?.preventDefault();
    if (!complete || checking || waiting) return;
    setChecking(true);
    try {
      const result = await commands.recoverWithCode(dashed(code));
      if (result.kind === "ok") {
        setCode("");
        await chooseNewPinInSettings(onProved);
        return;
      }
      showCheck(result);
    } catch (err) {
      show({ kind: "error", text: messageOf(err) });
    } finally {
      setChecking(false);
    }
    // Back in the field to correct the code (it stayed read-only, so focus never left it by itself).
    inputRef.current?.focus();
  }

  const current = Math.min(Math.floor(code.length / GROUP), RECOVERY_CODE_LENGTH / GROUP - 1);
  const titleId = useId();

  return (
    <Dialog titleId={titleId} onEscape={checking ? undefined : onClose} className="dn-pin-dialog dn-forgot dn-code-dialog">
      <form className="dn-code-form" onSubmit={(e) => void submit(e)}>
        <button type="button" className="dn-back-link" onClick={onClose} disabled={checking}>
          <span className="dn-back-icon">
            <Icon name="chevright" size={14} />
          </span>
          Back to PIN
        </button>
        <div id={titleId} className="dn-code-title">
          Enter your recovery code
        </div>
        <div className="dn-modal-text">
          The 24-character code you saved when you set up the lock. You will choose a new PIN next.
        </div>
        <div className="dn-code-entry">
          <div className="dn-code-groups" aria-hidden="true">
            {Array.from({ length: RECOVERY_CODE_LENGTH / GROUP }, (_, i) => {
              const part = code.slice(i * GROUP, (i + 1) * GROUP);
              const classes = ["dn-code-group"];
              if (!part) classes.push("is-empty");
              if (focused && !complete && i === current) classes.push("is-current");
              return (
                <span key={i} className={classes.join(" ")}>
                  {part || "····"}
                </span>
              );
            })}
          </div>
          <input
            ref={inputRef}
            className="dn-code-input"
            aria-label="Recovery code"
            aria-describedby={hintId}
            value={code}
            // Read-only, not disabled, while checking: a disabled field drops focus to the page.
            readOnly={checking}
            autoComplete="off"
            autoCapitalize="characters"
            autoCorrect="off"
            spellCheck={false}
            onChange={(e) => {
              setCode(normalizeRecoveryCode(e.target.value));
              if (message && message.kind !== "wait") show(null);
            }}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
          />
        </div>
        <PinStatus message={message} remaining={remaining} what="recovery code" />
        <div id={hintId} className="dn-code-hint">
          Dashes and spaces are added for you. Not case-sensitive.
        </div>
        <div className="dn-modal-actions">
          <button type="button" className="dn-btn-outline is-large" onClick={onClose} disabled={checking}>
            Cancel
          </button>
          <button type="submit" className="dn-btn-accent is-large" disabled={!complete || checking || waiting}>
            <span>Continue</span>
          </button>
        </div>
      </form>
    </Dialog>
  );
}

/** Neither the computer password nor a recovery code can be used here (D11). */
function LastResort({ onClose }: { onClose: () => void }) {
  return (
    <Shell title="Forgot your PIN?" onEscape={onClose}>
      <div className="dn-modal-text">
        DeskNotes has no other way to unlock private notes on this computer. As a last resort, quit DeskNotes
        (tray icon → Quit DeskNotes), then run <strong>desknotes --reset-pin</strong> in a terminal. It removes the
        PIN and keeps every note; DeskNotes says so at its next start.
      </div>
      <Actions>
        <BackButton onClick={onClose} />
      </Actions>
    </Shell>
  );
}
