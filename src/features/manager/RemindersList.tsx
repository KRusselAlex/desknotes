import { Icon } from "../../components/Icon";
import type { ReminderListRow } from "../../types/reminder";
import { highlight } from "./highlight";
import { groupReminders, reminderWhen, repeatLabel } from "./reminderGroups";

/**
 * The Reminders tab's rows (design R2), grouped Today / Tomorrow / Later. Each row is a
 * button that opens the note (the manager decides how: an archived note has no window). The title is what the command returned: "Private note" while
 * the note is locked.
 */
export function RemindersList({
  rows,
  now,
  query,
  onOpen,
}: {
  rows: ReminderListRow[];
  now: number;
  query: string;
  onOpen: (row: ReminderListRow) => void;
}) {
  return (
    <div className="dn-list is-grouped" role="list" aria-label="Reminders">
      {groupReminders(rows, now).map((group) => (
        <div key={group.label} className="dn-rem-group" role="presentation">
          <div className="dn-group-label">{group.label}</div>
          {group.rows.map((r) => (
            <div key={r.noteId} role="listitem" className={`dn-rem-row${r.overdue ? " is-overdue" : ""}`}>
              <button type="button" className="dn-rem-btn" onClick={() => onOpen(r)}>
                <span className="dn-row-dot" style={{ background: r.color }} />
                <span className={`dn-row-title${r.title ? "" : " is-empty"}`}>
                  {r.title ? highlight(r.title, query) : <em>Empty note</em>}
                </span>
                {r.repeat !== "none" && <span className="dn-rem-repeat">{repeatLabel(r.repeat)}</span>}
                <span className="dn-rem-chip">
                  <Icon name="bell" size={12} />
                  {reminderWhen(r, now)}
                </span>
              </button>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
