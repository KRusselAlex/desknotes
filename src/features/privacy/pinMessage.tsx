import { useCallback, useEffect, useState } from "react";
import { Icon } from "../../components/Icon";
import type { PinCheck } from "../../types/note";

/**
 * What a PIN or recovery-code entry says after a check (design "Wrong PIN · slowed down").
 * Shared by the PIN pad and the recovery code entry, which share the native wrong-PIN waits.
 */
export type PinMessage =
  | { kind: "wrong" }
  /** `wrong`: this attempt failed; otherwise a wait that was already running. */
  | { kind: "wait"; wrong: boolean; until: number; secs: number }
  | { kind: "error"; text: string };

/** A native message as a sentence: capital first letter, one full stop. */
export function sentence(text: string): string {
  const t = text.trim().replace(/\.$/, "");
  return t ? `${t[0]!.toUpperCase()}${t.slice(1)}.` : "Something went wrong.";
}

/** The message for a check that was not "ok" (null for "ok"). */
export function messageFromCheck(result: PinCheck, now: number): PinMessage | null {
  if (result.kind === "ok") return null;
  if (result.waitSecs > 0) {
    return { kind: "wait", wrong: result.kind === "wrong", until: now + result.waitSecs * 1000, secs: result.waitSecs };
  }
  return { kind: "wrong" };
}

/** A notice given when an entry appears: a check result or a sentence. */
export function messageFromNotice(notice: PinCheck | string | null | undefined, now: number): PinMessage | null {
  if (!notice) return null;
  return typeof notice === "string" ? { kind: "error", text: sentence(notice) } : messageFromCheck(notice, now);
}

/**
 * The current message and its wait countdown. A wait ticks every second, ends by itself,
 * and never shows more than the wait the native side announced, even if the clock moves back.
 */
export function usePinMessage(initial?: (now: number) => PinMessage | null) {
  const [now, setNow] = useState(() => Date.now());
  const [message, setMessage] = useState<PinMessage | null>(() => initial?.(Date.now()) ?? null);

  const show = useCallback((next: PinMessage | null) => {
    setNow(Date.now());
    setMessage(next);
  }, []);

  const showCheck = useCallback((result: PinCheck) => {
    const t = Date.now();
    setNow(t);
    setMessage(messageFromCheck(result, t));
  }, []);

  useEffect(() => {
    if (message?.kind !== "wait") return;
    const timer = setInterval(() => {
      const t = Date.now();
      setNow(t);
      if (t >= message.until) setMessage(null);
    }, 1000);
    return () => clearInterval(timer);
  }, [message]);

  const remaining =
    message?.kind === "wait" ? Math.min(message.secs, Math.max(0, Math.ceil((message.until - now) / 1000))) : 0;
  return { message, show, showCheck, remaining, waiting: remaining > 0 };
}

/** The always-present live region with the message pill (wrong, wait countdown or a sentence). */
export function PinStatus({
  message,
  remaining,
  what = "PIN",
  alertSize = 16,
}: {
  message: PinMessage | null;
  remaining: number;
  /** What was wrong: "Wrong PIN." or "Wrong recovery code.". */
  what?: string;
  alertSize?: number;
}) {
  let content = null;
  if (message?.kind === "wait" && remaining > 0) {
    content = (
      <>
        <Icon name="clock" size={16} />
        {message.wrong ? `Wrong ${what}. ` : ""}Try again in {remaining} s
      </>
    );
  } else if (message?.kind === "wrong") {
    content = (
      <>
        <Icon name="alert" size={alertSize} />
        Wrong {what}. Try again.
      </>
    );
  } else if (message?.kind === "error") {
    content = (
      <>
        <Icon name="alert" size={alertSize} />
        {message.text}
      </>
    );
  }
  return (
    <div className="dn-pin-status" role="status">
      {content && <span className="dn-pin-message">{content}</span>}
    </div>
  );
}

/** Whether a message is on screen (a finished wait shows nothing). */
export function showsMessage(message: PinMessage | null, remaining: number): boolean {
  return message !== null && (message.kind !== "wait" || remaining > 0);
}
