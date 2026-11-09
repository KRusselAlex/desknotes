import { useEffect, useState } from "react";
import { commands } from "../../ipc/commands";
import { onAutomationsChanged, onRemindersChanged } from "../../ipc/events";
import type { ReminderView } from "../../types/reminder";

/** How often the chip looks again, so "today" and "overdue" stay right while the window is open. */
const REMINDER_REFRESH_MS = 60_000;

/**
 * The note's reminder, read again when it changes (reminders-changed for this note, or for
 * several) and every minute. `null` while it has none, or while it cannot be read.
 */
export function useReminder(noteId: string): ReminderView | null {
  const [reminder, setReminder] = useState<ReminderView | null>(null);
  useEffect(() => {
    let live = true;
    const load = () => {
      commands.getReminder(noteId).then(
        (r) => live && setReminder(r),
        () => undefined,
      );
    };
    load();
    const timer = setInterval(load, REMINDER_REFRESH_MS);
    const unlisten = onRemindersChanged(({ noteId: changed }) => {
      if (changed === null || changed === noteId) load();
    });
    return () => {
      live = false;
      clearInterval(timer);
      void unlisten.then((f) => f());
    };
  }, [noteId]);
  return reminder;
}

/**
 * Automation rule 1, "Mark a checklist done when every item is ticked": read with the settings,
 * and again whenever Settings saves the rules. Off until known.
 */
export function useAutoCompleteRule(): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    let live = true;
    /** A change heard first is newer than the settings still being read. */
    let heard = false;
    commands.getSettings().then(
      (s) => live && !heard && setOn(s.automations.autoCompleteChecklists),
      () => undefined,
    );
    const unlisten = onAutomationsChanged((a) => {
      heard = true;
      setOn(a.autoCompleteChecklists);
    });
    return () => {
      live = false;
      void unlisten.then((f) => f());
    };
  }, []);
  return on;
}

/** A repeating reminder makes the note a routine: rule 1 leaves it open (owner decision 2026-11-06). */
export function isRepeating(reminder: ReminderView | null): boolean {
  const repeat: string | undefined = reminder?.repeat;
  return repeat !== undefined && repeat !== "none";
}
