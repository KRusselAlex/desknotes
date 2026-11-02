// Tells the native side that the person is using DeskNotes, so the privacy
// lock's inactivity timer (Settings → Privacy, 1–15 min) does not run out while
// they type or click in any DeskNotes window. DeskNotes cannot see input to other apps.

import { useEffect } from "react";
import { commands } from "../ipc/commands";

/** At most one report per this many milliseconds (ruling R16). */
export const ACTIVITY_REPORT_INTERVAL_MS = 30_000;

const INPUT_EVENTS = ["pointerdown", "keydown", "wheel"] as const;

/**
 * Calls `report` on input in `target`, at most once per `intervalMs`: the first
 * input reports at once, later ones are skipped until the interval has passed.
 * While typing continues a report goes out at least every `intervalMs`, so the
 * shortest inactivity setting (1 min) never runs out mid-typing.
 * Returns a function that stops listening.
 */
export function startActivityReporter(
  report: () => Promise<unknown>,
  target: Pick<Window, "addEventListener" | "removeEventListener"> = window,
  intervalMs = ACTIVITY_REPORT_INTERVAL_MS,
): () => void {
  let last: number | null = null;
  const onInput = () => {
    const now = Date.now();
    // `now < last`: the clock was moved back; report rather than go quiet.
    if (last !== null && now >= last && now - last < intervalMs) return;
    last = now;
    report().catch(() => undefined); // nothing to do if the native side is busy or absent
  };
  // Capture phase: components that stop propagation (menus, dialogs) still count.
  for (const type of INPUT_EVENTS) target.addEventListener(type, onInput, { capture: true, passive: true });
  return () => {
    for (const type of INPUT_EVENTS) target.removeEventListener(type, onInput, { capture: true });
  };
}

/** Reports input in this window (manager, notes, settings) for the inactivity lock. */
export function useActivityReporter(): void {
  useEffect(() => startActivityReporter(() => commands.reportActivity()), []);
}
