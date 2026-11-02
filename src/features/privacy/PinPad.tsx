import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Icon } from "../../components/Icon";
import { commands } from "../../ipc/commands";
import type { PinCheck } from "../../types/note";

/** The PIN is exactly this many digits (Rust `PIN_DIGITS`). */
export const PIN_LENGTH = 6;

/** Keypad order from the design (L2): 1–9, a blank, 0, delete. */
const KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "", "0", "back"] as const;

type Message =
  | { kind: "wrong" }
  /** `wrong`: this attempt failed; otherwise a wait that was already running. */
  | { kind: "wait"; wrong: boolean; until: number; secs: number }
  | { kind: "error"; text: string };

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
}

function sentence(text: string): string {
  const t = text.trim().replace(/\.$/, "");
  return t ? `${t[0]!.toUpperCase()}${t.slice(1)}.` : "Something went wrong.";
}

/** The message for a check that was not "ok" (null for "ok"). */
function fromCheck(result: PinCheck, now: number): Message | null {
  if (result.kind === "ok") return null;
  if (result.waitSecs > 0) {
    return { kind: "wait", wrong: result.kind === "wrong", until: now + result.waitSecs * 1000, secs: result.waitSecs };
  }
  return { kind: "wrong" };
}

function fromNotice(notice: PinCheck | string | null | undefined, now: number): Message | null {
  if (!notice) return null;
  return typeof notice === "string" ? { kind: "error", text: sentence(notice) } : fromCheck(notice, now);
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
}: PinPadProps) {
  const digits = useRef<string[]>([]);
  const [count, setCount] = useState(0);
  const [checking, setChecking] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [message, setMessage] = useState<Message | null>(() => fromNotice(notice, now));

  // Never more than the wait the native side announced, even if the clock moves back.
  const remaining =
    message?.kind === "wait" ? Math.min(message.secs, Math.max(0, Math.ceil((message.until - now) / 1000))) : 0;
  const waiting = remaining > 0;
  const disabled = checking || waiting;

  useEffect(() => {
    if (message?.kind !== "wait") return;
    const timer = setInterval(() => {
      const t = Date.now();
      setNow(t);
      if (t >= message.until) setMessage(null);
    }, 1000);
    return () => clearInterval(timer);
  }, [message]);

  const submit = useCallback(
    async (pin: string) => {
      setChecking(true);
      let next: Message | null = null;
      let ok = false;
      try {
        const result = await check(pin);
        if (result?.kind === "ok") ok = true;
        else if (result) {
          const t = Date.now();
          setNow(t);
          next = fromCheck(result, t);
        }
      } catch (e) {
        next = { kind: "error", text: sentence(e instanceof Error ? e.message : String(e)) };
      }
      setCount(0);
      setChecking(false);
      setMessage(next);
      if (ok) onUnlocked();
    },
    [check, onUnlocked],
  );

  const press = useCallback(
    (digit: string) => {
      if (disabled || digits.current.length >= PIN_LENGTH) return;
      if (message) setMessage(null);
      digits.current.push(digit);
      setCount(digits.current.length);
      if (digits.current.length === PIN_LENGTH) {
        const pin = digits.current.join("");
        digits.current = [];
        void submit(pin);
      }
    },
    [disabled, message, submit],
  );

  const back = useCallback(() => {
    if (disabled) return;
    digits.current.pop();
    setCount(digits.current.length);
  }, [disabled]);

  useEffect(() => {
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
  }, [press, back]);

  // Forget the digits if the pad goes away mid-entry.
  useEffect(
    () => () => {
      digits.current = [];
    },
    [],
  );

  let status: ReactNode = null;
  if (message?.kind === "wait" && waiting) {
    status = (
      <>
        <Icon name="clock" size={16} />
        {message.wrong ? "Wrong PIN. " : ""}Try again in {remaining} s
      </>
    );
  } else if (message?.kind === "wrong") {
    status = (
      <>
        <Icon name="alert" size={variant === "app" ? 14 : 16} />
        Wrong PIN. Try again.
      </>
    );
  } else if (message?.kind === "error") {
    status = (
      <>
        <Icon name="alert" size={variant === "app" ? 14 : 16} />
        {message.text}
      </>
    );
  }

  const failed = message?.kind === "wrong" || message?.kind === "error";
  const classes = ["dn-pinpad", `is-${variant}`];
  if (waiting) classes.push("is-waiting");
  if (status) classes.push("has-status");
  if (failed) classes.push("has-error");

  return (
    <div className={classes.join(" ")} role="group" aria-label={label} aria-busy={checking}>
      <div className="dn-pin-status" role="status">
        {status && <span className="dn-pin-message">{status}</span>}
      </div>
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
