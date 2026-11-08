import { useEffect, useRef, useState } from "react";
import { Icon } from "../../components/Icon";
import { Segmented } from "../../components/Segmented";
import { commands } from "../../ipc/commands";
import type { ReminderView, Repeat } from "../../types/reminder";
import { refusalText } from "../privacy/refusal";
import { defaultReminder } from "./reminderText";
import { parseTime } from "./timeInput";

const REPEATS: { value: Repeat; label: string }[] = [
  { value: "none", label: "None" },
  { value: "daily", label: "Daily" },
  { value: "weekdays", label: "Weekdays" },
  { value: "weekly", label: "Weekly" },
  { value: "monthly", label: "Monthly" },
];

/**
 * Set, change or remove a note's reminder (design R1): the date and the time, how it
 * repeats, Remove (only when there is one) and Save. A refusal ("Pick a time in the
 * future.") shows under the inputs and keeps it open. Esc and a click outside close it;
 * a click on a `data-popover-toggle` (the chip) is left to that toggle.
 */
export function ReminderPopover({
  noteId,
  initial,
  onClose,
}: {
  noteId: string;
  /** The note's reminder, or null for a new one. */
  initial: ReminderView | null;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const dateRef = useRef<HTMLInputElement>(null);
  const [start] = useState(() => initial ?? { ...defaultReminder(new Date()), repeat: "none" as Repeat });
  const [date, setDate] = useState(start.date);
  // What is typed in the time field; `time` is what it reads as, or null.
  const [timeText, setTimeText] = useState(start.time);
  const time = parseTime(timeText);
  // Set once the field is left with a time it cannot read, and cleared as soon as the text
  // reads as one again, so a time half typed ("14:", "093") is never marked.
  const [timeLeft, setTimeLeft] = useState(false);
  const timeInvalid = timeLeft && time === null && timeText.trim() !== "";
  const [repeat, setRepeat] = useState<Repeat>(start.repeat);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    dateRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      onClose();
    };
    const onDown = (e: PointerEvent) => {
      const t = e.target as Element;
      if (!ref.current?.contains(t) && !t.closest("[data-popover-toggle]")) onClose();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onDown);
    };
  }, [onClose]);

  /** Runs a command; closes on success, shows the reason and stays open otherwise. */
  async function run(action: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (e) {
      setError(refusalText(e));
      setBusy(false);
      return;
    }
    onClose();
  }

  const complete = date !== "" && time !== null;

  return (
    <div ref={ref} className="dn-popover dn-reminder" role="dialog" aria-label="Reminder">
      <div className="dn-reminder-when">
        <input
          ref={dateRef}
          type="date"
          aria-label="Date"
          className="dn-reminder-date"
          value={date}
          onChange={(e) => {
            setDate(e.target.value);
            setError(null);
          }}
        />
        {/* A text field, not type="time": WebKitGTK's never moves on from the hour (see timeInput.ts). */}
        <input
          type="text"
          aria-label="Time"
          aria-invalid={timeInvalid}
          className="dn-reminder-time"
          value={timeText}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => {
            setTimeText(e.target.value);
            if (parseTime(e.target.value) !== null) setTimeLeft(false);
            setError(null);
          }}
          onBlur={() => {
            if (time !== null) setTimeText(time);
            else setTimeLeft(true);
          }}
        />
      </div>
      {error && (
        <div role="alert" className="dn-link-error dn-reminder-error">
          <Icon name="alert" size={13} />
          {error}
        </div>
      )}
      <div className="dn-popover-title">Repeat</div>
      <Segmented label="Repeat" options={REPEATS} value={repeat} onChange={setRepeat} />
      <div className="dn-reminder-actions">
        {initial ? (
          <button type="button" className="dn-reminder-remove" disabled={busy} onClick={() => void run(() => commands.removeReminder(noteId))}>
            Remove
          </button>
        ) : (
          <span />
        )}
        <button
          type="button"
          className="dn-pill-ink"
          disabled={busy || !complete}
          onClick={() => {
            if (time !== null) void run(() => commands.setReminder(noteId, date, time, repeat));
          }}
        >
          Save
        </button>
      </div>
    </div>
  );
}
