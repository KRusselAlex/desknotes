import { useEffect, useRef, useState } from "react";
import { Switch } from "../../components/Switch";
import { commands } from "../../ipc/commands";
import type { Automations } from "../../types/note";

/** The question "Empty old trash?" waits on: `days` and how many notes would go right now. */
interface PurgeQuestion {
  days: number;
  count: number;
  /** Resolves the day field's save: true if the answer was "Turn on" and it was saved. */
  answer: (saved: boolean) => void;
}

/** `after [N] days`: a pill field saved on Enter or when focus leaves, greyed while its rule is off. */
function DaysField({
  label,
  value,
  off,
  onSave,
}: {
  label: string;
  value: number;
  off: boolean;
  onSave: (days: number) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState(String(value));
  // When the saved value changes (another save, another window), show it.
  const [shown, setShown] = useState(value);
  if (shown !== value) {
    setShown(value);
    setDraft(String(value));
  }

  async function commit() {
    const text = draft.trim();
    const days = /^\d+$/.test(text) ? Number(text) : NaN;
    if (Number.isNaN(days)) {
      setDraft(String(value));
      return;
    }
    if (days === value) {
      setDraft(String(value));
      return;
    }
    if (!(await onSave(days))) setDraft(String(value));
  }

  return (
    <div className={`dn-days${off ? " is-off" : ""}`}>
      <span>after</span>
      <input
        className="dn-size-field"
        inputMode="numeric"
        maxLength={3} // the ranges end at 90 and 365
        aria-label={label}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => void commit()}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur(); // blur saves
        }}
      />
      <span>days</span>
    </div>
  );
}

/**
 * Settings → Automations: four rules, each off until turned on. It shows `value` and asks
 * `onSave` to save the whole object with one field changed (null if it was refused, in which
 * case the window shows why). Only "Empty old trash", which deletes for good, asks first.
 */
export function AutomationsPane({
  value,
  onSave,
  onError,
}: {
  value: Automations;
  onSave: (next: Automations) => Promise<Automations | null>;
  onError: (e: Error) => void;
}) {
  // Saves run one after another, each on top of the last saved object, so two quick changes
  // never overwrite each other.
  const latest = useRef(value);
  useEffect(() => {
    latest.current = value;
  }, [value]);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  function save(change: Partial<Automations>): Promise<boolean> {
    const run = queue.current.then(async () => {
      const saved = await onSave({ ...latest.current, ...change });
      if (saved) latest.current = saved;
      return saved !== null;
    });
    queue.current = run.catch(() => undefined);
    return run;
  }

  const [question, setQuestion] = useState<PurgeQuestion | null>(null);
  const asking = useRef(false); // a count or the dialog is under way

  function ask(days: number, count: number): Promise<boolean> {
    return new Promise((resolve) => {
      setQuestion({ days, count, answer: resolve });
    });
  }

  async function answer(turnOn: boolean) {
    const q = question;
    if (!q) return;
    setQuestion(null);
    const saved = turnOn ? await save({ purgeTrashEnabled: true, purgeTrashDays: q.days }) : false;
    asking.current = false;
    q.answer(saved);
  }

  /** Counts, then asks, when this would delete notes `change` has not already put at risk. */
  async function confirmPurge(days: number, previous: number | null): Promise<boolean> {
    if (asking.current) return false;
    asking.current = true;
    try {
      const [count, before] = await Promise.all([
        commands.countPurgeable(days),
        previous === null ? Promise.resolve(-1) : commands.countPurgeable(previous),
      ]);
      if (previous !== null && count <= before) {
        asking.current = false;
        return save({ purgeTrashDays: days });
      }
      return await ask(days, count); // `answer` ends the hold
    } catch (e) {
      asking.current = false;
      onError(e as Error);
      return false;
    }
  }

  const turnPurgeOn = (next: boolean) => {
    if (!next) void save({ purgeTrashEnabled: false });
    else void confirmPurge(latest.current.purgeTrashDays, null);
  };
  const changePurgeDays = (days: number) =>
    latest.current.purgeTrashEnabled
      ? confirmPurge(days, latest.current.purgeTrashDays)
      : save({ purgeTrashDays: days });

  return (
    <>
      <h1>Automations</h1>
      <p className="dn-auto-intro">
        Small rules DeskNotes follows for you, on this computer only. Each one is off until you turn it on.
      </p>
      <div className="dn-card">
        <div className="dn-card-row">
          <div className="dn-card-text">
            <div className="dn-card-label">Mark a checklist done when every item is ticked</div>
            <div className="dn-card-sub">
              The note moves to Completed, with Undo for a few seconds. Notes with a repeating reminder stay open.
            </div>
          </div>
          <Switch
            label="Mark a checklist done when every item is ticked"
            checked={value.autoCompleteChecklists}
            onChange={(next) => void save({ autoCompleteChecklists: next })}
          />
        </div>
        <div className="dn-card-sep" />
        <div className="dn-card-row">
          <div className="dn-card-text">
            <div className="dn-card-label">Untick a checklist when its repeating reminder goes off</div>
            <div className="dn-card-sub">Good for daily or weekly routines.</div>
          </div>
          <Switch
            label="Untick a checklist when its repeating reminder goes off"
            checked={value.resetChecklistsOnRepeat}
            onChange={(next) => void save({ resetChecklistsOnRepeat: next })}
          />
        </div>
        <div className="dn-card-sep" />
        <div className="dn-card-row">
          <div className="dn-card-text">
            <div className="dn-card-label">Archive done notes</div>
            <div className="dn-card-sub">Nothing is deleted; they stay in Archived.</div>
          </div>
          <DaysField
            label="Archive done notes after (days)"
            value={value.archiveDoneDays}
            off={!value.archiveDoneEnabled}
            onSave={(days) => save({ archiveDoneDays: days })}
          />
          <Switch
            label="Archive done notes"
            checked={value.archiveDoneEnabled}
            onChange={(next) => void save({ archiveDoneEnabled: next })}
          />
        </div>
        <div className="dn-card-sep" />
        <div className="dn-card-row">
          <div className="dn-card-text">
            <div className="dn-card-label">Empty old trash</div>
            <div className="dn-card-sub is-danger">Deletes notes for good. Backups you made keep them.</div>
            {value.purgeOffByRestore && (
              <div className="dn-card-sub">Turned off when a backup was restored.</div>
            )}
          </div>
          <DaysField
            label="Empty old trash after (days)"
            value={value.purgeTrashDays}
            off={!value.purgeTrashEnabled}
            onSave={changePurgeDays}
          />
          <Switch label="Empty old trash" checked={value.purgeTrashEnabled} onChange={turnPurgeOn} />
        </div>
      </div>
      {question && <PurgeDialog question={question} onAnswer={(turnOn) => void answer(turnOn)} />}
    </>
  );
}

/** "Empty old trash?" in the look of "Restore this backup?". Cancel has the focus. */
function PurgeDialog({ question, onAnswer }: { question: PurgeQuestion; onAnswer: (turnOn: boolean) => void }) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    cancelRef.current?.focus();
    return () => {
      if (opener?.isConnected) opener.focus();
    };
  }, []);
  const { days, count } = question;
  return (
    <div className="dn-modal-backdrop" onKeyDown={(e) => e.key === "Escape" && onAnswer(false)}>
      <div className="dn-modal" role="alertdialog" aria-modal="true" aria-labelledby="purge-title" aria-describedby="purge-text">
        <div id="purge-title" className="dn-modal-title">
          Empty old trash?
        </div>
        <div id="purge-text" className="dn-modal-body">
          <div className="dn-modal-text">
            Notes that have been in the trash for more than <strong>{days} days</strong> will be deleted for good, now
            and from then on.{" "}
            {count === 0 ? (
              "There are no such notes right now."
            ) : count === 1 ? (
              <>
                There is <strong>1</strong> such note right now.
              </>
            ) : (
              <>
                There are <strong>{count}</strong> such notes right now.
              </>
            )}
          </div>
          <div className="dn-modal-text">This can't be undone. Backups you have already made still contain them.</div>
        </div>
        <div className="dn-modal-actions">
          <button ref={cancelRef} type="button" className="dn-btn-outline is-large" onClick={() => onAnswer(false)}>
            Cancel
          </button>
          <button type="button" className="dn-btn-danger is-large" onClick={() => onAnswer(true)}>
            Turn on
          </button>
        </div>
      </div>
    </div>
  );
}
