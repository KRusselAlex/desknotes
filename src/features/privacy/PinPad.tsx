import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "../../components/Icon";
import { commands } from "../../ipc/commands";
import type { PinCheck } from "../../types/note";
import { messageFromNotice, PinStatus, sentence, showsMessage, usePinMessage } from "./pinMessage";

/** The PIN is exactly this many digits (Rust `PIN_DIGITS`). */
export const PIN_LENGTH = 6;

/** Keypad order from the design (L2): 1–9, a blank, 0, delete. */
const KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "", "0", "back"] as const;

export interface PinPadProps {
  /** The check answered "ok" (with the default check: every private note is unlocked). */
  onUnlocked: () => void;
  /** "Forgot your PIN?" was chosen. Without it the link is not shown. */
  onForgot?: () => void;
  /**
   * Checks the six digits, sent once. Default: `commands.unlock`. Answer `null` when the
   * caller moved on by itself (e.g. to the next step); a thrown error's message is shown.
   */
  check?: (pin: string) => Promise<PinCheck | null>;
  /** Shown when the pad appears, until the next digit (a wrong PIN, a wait or a sentence). */
  notice?: PinCheck | string | null;
  /**
   * "note": inside a note (design "PIN inside a note"), with its keypad.
   * "app": in a Settings dialog (design "Confirm PIN mismatch · Change PIN"): app colours,
   * larger dots, the message under them, typed on the keyboard (no keypad drawn there).
   */
  variant?: "note" | "app";
  /** Accessible name of the pad. */
  label?: string;
  /**
   * Another screen is over the pad (e.g. "Forgot your PIN?"): it ignores the keyboard, so
   * digits typed there never reach this pad and are never sent as a PIN.
   */
  paused?: boolean;
}

/**
 * Six-digit PIN entry (design "PIN inside a note" and "Wrong PIN · slowed down").
 * The digits typed live only in a ref until they are sent once to `check`
 * (`unlock` by default); the page shows filled dots, never the digits. Keyboard
 * digits and Backspace work anywhere in the window except inside text fields.
 */
export function PinPad({
  onUnlocked,
  onForgot,
  check = commands.unlock,
  notice,
  variant = "note",
  label = "Enter your PIN",
  paused = false,
}: PinPadProps) {
  const digits = useRef<string[]>([]);
  const [count, setCount] = useState(0);
  const [checking, setChecking] = useState(false);
  const { message, show, showCheck, remaining, waiting } = usePinMessage((now) => messageFromNotice(notice, now));
  const disabled = checking || waiting || paused;

  const submit = useCallback(
    async (pin: string) => {
      setChecking(true);
      let ok = false;
      try {
        const result = await check(pin);
        if (result?.kind === "ok") {
          ok = true;
          show(null);
        } else if (result) showCheck(result);
        else show(null);
      } catch (e) {
        show({ kind: "error", text: sentence(e instanceof Error ? e.message : String(e)) });
      }
      setCount(0);
      setChecking(false);
      if (ok) onUnlocked();
    },
    [check, onUnlocked, show, showCheck],
  );

  const press = useCallback(
    (digit: string) => {
      if (disabled || digits.current.length >= PIN_LENGTH) return;
      if (message) show(null);
      digits.current.push(digit);
      setCount(digits.current.length);
      if (digits.current.length === PIN_LENGTH) {
        const pin = digits.current.join("");
        digits.current = [];
        void submit(pin);
      }
    },
    [disabled, message, show, submit],
  );

  const back = useCallback(() => {
    if (disabled) return;
    digits.current.pop();
    setCount(digits.current.length);
  }, [disabled]);

  useEffect(() => {
    if (paused) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if ((e.target as HTMLElement | null)?.closest?.("input, textarea, select, [contenteditable='true']")) return;
      if (/^[0-9]$/.test(e.key)) press(e.key);
      else if (e.key === "Backspace") back();
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [press, back, paused]);

  // Forget the digits if the pad goes away mid-entry.
  useEffect(
    () => () => {
      digits.current = [];
    },
    [],
  );

  const status = showsMessage(message, remaining);
  const failed = message?.kind === "wrong" || message?.kind === "error";
  const classes = ["dn-pinpad", `is-${variant}`];
  if (waiting) classes.push("is-waiting");
  if (status) classes.push("has-status");
  if (failed) classes.push("has-error");

  return (
    <div className={classes.join(" ")} role="group" aria-label={label} aria-busy={checking}>
      <PinStatus message={message} remaining={remaining} alertSize={variant === "app" ? 14 : 16} />
      <div className="dn-pin-dots" role="img" aria-label={`${count} of ${PIN_LENGTH} digits`}>
        {Array.from({ length: PIN_LENGTH }, (_, i) => (
          <span key={i} className={`dn-pin-dot${i < count ? " is-filled" : ""}`} />
        ))}
      </div>
      {variant === "note" && (
        <div className="dn-pin-keys" aria-disabled={disabled || undefined}>
          {KEYS.map((k, i) =>
            k === "" ? (
              <span key={i} aria-hidden="true" />
            ) : k === "back" ? (
              <button
                key={i}
                type="button"
                className="dn-pin-key is-plain"
                aria-label="Delete digit"
                disabled={disabled}
                onClick={back}
              >
                <Icon name="backspace" size={17} />
              </button>
            ) : (
              <button key={i} type="button" className="dn-pin-key" disabled={disabled} onClick={() => press(k)}>
                {k}
              </button>
            ),
          )}
        </div>
      )}
      {onForgot && (
        <button type="button" className="dn-pin-forgot" onClick={onForgot}>
          Forgot your PIN?
        </button>
      )}
    </div>
  );
}
