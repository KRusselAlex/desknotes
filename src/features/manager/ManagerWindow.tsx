import { Fragment, useCallback, useEffect, useRef, useState, type MouseEvent } from "react";
import { dateGroup, doneDateLabel, listDateLabel } from "../../app/time";
import { useWindowSize } from "../../app/useWindowSize";
import { Icon } from "../../components/Icon";
import { Menu } from "../../components/Menu";
import { commands } from "../../ipc/commands";
import { onActionFailed, onNotesChanged, onPrivacyChanged, onQuitBlocked, onRemindersChanged } from "../../ipc/events";
import { PRIVATE_FALLBACK_LABEL, type NoteCounts, type NoteFilter, type NoteSummary, type PrivacyStatus } from "../../types/note";
import type { ReminderListRow } from "../../types/reminder";
import { refusalText } from "../privacy/refusal";
import { highlight } from "./highlight";
import { RemindersList } from "./RemindersList";

export { highlight };

/** The tab bar's own ids: the note lists, plus Reminders, which is not a note filter. */
type ManagerTab = NoteFilter | "reminders";

const TABS: { id: ManagerTab; label: string }[] = [
  { id: "active", label: "Active" },
  { id: "completed", label: "Completed" },
  { id: "reminders", label: "Reminders" },
  { id: "archived", label: "Archived" },
  { id: "trash", label: "Trash" },
];

/** While the Reminders tab is shown it reloads this often, so Today, Tomorrow and Overdue stay right. */
const REMINDERS_TICK_MS = 60_000;

/** Above this many notes the list switches to compact rows grouped by date (design M7). */
const GROUP_THRESHOLD = 12;
/** Below this width the New note button drops its label (design M3). */
const COMPACT_WIDTH = 480;

const resetDate = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

/** What a row shows as its name: a locked private note's label, never its title (D2). */
function rowName(n: NoteSummary): string {
  return n.locked ? n.privateLabel || PRIVATE_FALLBACK_LABEL : n.title;
}

export function ManagerWindow() {
  const [tab, setTab] = useState<ManagerTab>("active");
  const [query, setQuery] = useState("");
  const [notes, setNotes] = useState<NoteSummary[] | null>(null);
  const [counts, setCounts] = useState<NoteCounts | null>(null);
  // The Reminders tab: its rows, the clock they were read at, and how many reminders exist in all.
  const [reminders, setReminders] = useState<{ rows: ReminderListRow[]; now: number } | null>(null);
  const [reminderTotal, setReminderTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [startupErrors, setStartupErrors] = useState<string[]>([]);
  const [confirmPurge, setConfirmPurge] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [hiddenCount, setHiddenCount] = useState(0);
  const [privacy, setPrivacy] = useState<PrivacyStatus | null>(null);
  /** Only the newest read of the lock state is shown. */
  const privacyRead = useRef(0);
  const searchRef = useRef<HTMLInputElement>(null);
  const { width } = useWindowSize();
  const searching = query.trim() !== "";

  const refresh = useCallback(async () => {
    // The lock state only decides "Lock now" and the reset notice; the list does not wait for it.
    // A failed read keeps what was last known (the reset notice stays); the next refresh asks again.
    const read = ++privacyRead.current;
    commands.privacyStatus().then(
      (s) => {
        if (read === privacyRead.current) setPrivacy(s);
      },
      () => undefined,
    );
    try {
      // Reminders are read on their own: if they fail, the notes and counts still update,
      // the tab keeps its last count and only the Reminders tab says what went wrong.
      let remindersError: string | null = null;
      const orNull = (p: Promise<ReminderListRow[]>) =>
        p.catch((e: unknown) => {
          remindersError = (e as Error).message;
          return null;
        });
      // The tab's count is every reminder, whatever the search says (R2).
      const all = orNull(commands.listReminders(""));
      const [list, c, hidden, allReminders, shownReminders] = await Promise.all([
        tab === "reminders" ? null : commands.listNotes(tab, query),
        commands.noteCounts(),
        commands.hiddenNoteCount(),
        all,
        tab !== "reminders" ? null : query.trim() === "" ? all : orNull(commands.listReminders(query)),
      ]);
      if (list) setNotes(list);
      setCounts(c);
      if (allReminders) setReminderTotal(allReminders.length);
      if (shownReminders) setReminders({ rows: shownReminders, now: Date.now() });
      setHiddenCount(hidden);
      setError(tab === "reminders" ? remindersError : null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [tab, query]);

  useEffect(() => {
    const t = setTimeout(() => void refresh(), 120);
    return () => clearTimeout(t);
  }, [refresh]);

  useEffect(() => {
    const unlisten = onNotesChanged(() => void refresh());
    const unlistenPrivacy = onPrivacyChanged(({ locked }) => {
      // Known at once, even if the read that follows fails.
      setPrivacy((p) => p && { ...p, locked });
      void refresh();
    });
    const unlistenReminders = onRemindersChanged(() => void refresh());
    return () => {
      void unlisten.then((f) => f());
      void unlistenPrivacy.then((f) => f());
      void unlistenReminders.then((f) => f());
    };
  }, [refresh]);

  useEffect(() => {
    if (tab !== "reminders") return;
    const id = setInterval(() => void refresh(), REMINDERS_TICK_MS);
    return () => clearInterval(id);
  }, [tab, refresh]);

  useEffect(() => {
    commands.startupErrors().then(setStartupErrors, () => undefined);
    const unlisten = onQuitBlocked((count) =>
      setError(
        `DeskNotes did not quit: ${count} ${count === 1 ? "note has" : "notes have"} unsaved text. ` +
          "Look for the note showing \"Not saved\" and press Retry.",
      ),
    );
    const unlistenFailed = onActionFailed((message) => setError(message));
    return () => {
      void unlisten.then((f) => f());
      void unlistenFailed.then((f) => f());
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const key = e.key.toLowerCase();
      if (key === "n") {
        e.preventDefault();
        void run(commands.createNote);
      } else if (key === "f") {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  async function run(action: () => Promise<unknown>) {
    try {
      await action();
      await refresh();
    } catch (e) {
      // e.g. a locked private note cannot be deleted for good (D12): say why.
      setError(refusalText(e));
    }
  }

  const banner = error ?? startupErrors[0] ?? null;
  const countOf = (id: ManagerTab) => (id === "reminders" ? reminderTotal : (counts?.[id] ?? 0));
  const grouped = !searching && tab === "active" && (notes?.length ?? 0) > GROUP_THRESHOLD;

  return (
    <div className="dn-manager">
      <div className="dn-mgr-top">
        <button
          type="button"
          className="dn-btn-accent"
          aria-label="New note"
          title="New note (Ctrl+N)"
          onClick={() => void run(commands.createNote)}
        >
          <Icon name="plus" stroke={2.75} />
          {width >= COMPACT_WIDTH && <span>New note</span>}
        </button>
        <label className={`dn-search${searching ? " has-value" : ""}`}>
          <Icon name="search" />
          <input
            ref={searchRef}
            type="search"
            aria-label="Search notes"
            placeholder="Search notes"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setQuery("");
            }}
          />
          {searching ? (
            <button type="button" className="dn-search-clear" aria-label="Clear search" onClick={() => setQuery("")}>
              <Icon name="close" size={13} />
            </button>
          ) : (
            width >= COMPACT_WIDTH && <kbd className="dn-kbd">Ctrl+F</kbd>
          )}
        </label>
        <div className="dn-mgr-menu-wrap">
          <button
            type="button"
            className="dn-app-icon-btn"
            aria-label="Menu"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen(!menuOpen)}
          >
            <Icon name="more" size={18} />
          </button>
          {menuOpen && (
            <Menu
              label="DeskNotes menu"
              className="dn-mgr-menu"
              onClose={() => setMenuOpen(false)}
              items={[
                { id: "hide-all", label: "Hide all notes", icon: "eyeoff", onSelect: () => void run(commands.hideAllNotes) },
                ...(hiddenCount > 0
                  ? [
                      {
                        id: "show-hidden",
                        label: `Show hidden notes (${hiddenCount})`,
                        icon: "eye" as const,
                        onSelect: () => void run(commands.showHiddenNotes),
                      },
                    ]
                  : []),
                ...(privacy?.enabled && !privacy.locked
                  ? [{ id: "lock-now", label: "Lock now", icon: "lock" as const, onSelect: () => void run(commands.lockNow) }]
                  : []),
                { id: "settings", label: "Settings…", icon: "settings", separatorBefore: true, onSelect: () => void commands.openSettings() },
                { id: "quit", label: "Quit DeskNotes", icon: "quit", separatorBefore: true, onSelect: () => void commands.quitApp() },
              ]}
            />
          )}
        </div>
      </div>

      {privacy?.resetAt != null && (
        <div className="dn-banner-error" role="alert">
          <Icon name="shield" size={18} />
          <span>
            The PIN was reset on {resetDate.format(privacy.resetAt)}. Private notes are not locked until you choose a
            new PIN in Settings → Privacy.
          </span>
          <button type="button" onClick={() => void run(commands.acknowledgePinReset)}>
            OK
          </button>
        </div>
      )}

      {banner && (
        <div className="dn-banner-error" role="alert">
          <Icon name="alert" size={18} />
          <span>{banner}</span>
          <button
            type="button"
            onClick={() => {
              setStartupErrors([]);
              void refresh();
            }}
          >
            Retry
          </button>
        </div>
      )}

      <div className="dn-tabs" role="tablist" aria-label="Note lists">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            type="button"
            aria-selected={tab === t.id}
            onClick={() => {
              setTab(t.id);
              setConfirmPurge(null);
            }}
          >
            {t.label}
            {counts && countOf(t.id) > 0 && <span className="dn-tab-count">{countOf(t.id)}</span>}
          </button>
        ))}
      </div>

      {searching && tab !== "reminders" && notes && notes.length > 0 && (
        <div className="dn-search-info">
          {notes.length} {notes.length === 1 ? "note" : "notes"} in {TABS.find((t) => t.id === tab)?.label}
        </div>
      )}

      {tab === "reminders" ? (
        reminders === null ? (
          <div className="dn-list" aria-busy="true" />
        ) : reminders.rows.length === 0 ? (
          <EmptyState tab={tab} searching={searching} onCreate={() => undefined} />
        ) : (
          <RemindersList
            rows={reminders.rows}
            now={reminders.now}
            query={query}
            onOpen={(r) => {
              if (r.archived) {
                // An archived note has no window: show it where it lives (R17).
                setTab("archived");
                setQuery("");
                setConfirmPurge(null);
              } else {
                void run(() => commands.showNote(r.noteId));
              }
            }}
          />
        )
      ) : notes === null ? (
        <div className="dn-list" aria-busy="true" />
      ) : notes.length === 0 ? (
        <EmptyState tab={tab} searching={searching} onCreate={() => void run(commands.createNote)} />
      ) : (
        <div className={`dn-list${grouped ? " is-grouped" : ""}`} role="list" aria-label={`${tab} notes`}>
          {notes.map((n, i) => {
            const group = grouped ? dateGroup(n.updatedAt) : null;
            const prev = notes[i - 1];
            const showGroup = group !== null && (!prev || dateGroup(prev.updatedAt) !== group);
            return (
              <Fragment key={n.id}>
                {showGroup && <div className="dn-group-label">{group}</div>}
                {confirmPurge === n.id ? (
                  <PurgeConfirm
                    note={n}
                    onCancel={() => setConfirmPurge(null)}
                    onDelete={() =>
                      void run(async () => {
                        setConfirmPurge(null);
                        await commands.purgeNote(n.id);
                      })
                    }
                  />
                ) : (
                  <NoteRow
                    note={n}
                    tab={tab}
                    query={query}
                    compact={grouped}
                    run={run}
                    onAskPurge={() => setConfirmPurge(n.id)}
                  />
                )}
              </Fragment>
            );
          })}
        </div>
      )}

      {tab === "trash" && notes && notes.length > 0 && (
        <div className="dn-list-footer">Notes in the trash are kept until you delete them.</div>
      )}
    </div>
  );
}

function rowMeta(n: NoteSummary, tab: NoteFilter): string {
  if (tab === "trash") return `Trashed ${listDateLabel(n.deletedAt ?? n.updatedAt)}`;
  if (tab === "completed") return doneDateLabel(n.completedAt ?? n.updatedAt);
  if (tab === "archived") return `Archived ${listDateLabel(n.archivedAt ?? n.updatedAt)}`;
  return `${listDateLabel(n.updatedAt)} · ${n.visible ? "On desktop" : "Hidden"}`;
}

interface RowProps {
  note: NoteSummary;
  tab: NoteFilter;
  query: string;
  compact: boolean;
  run: (action: () => Promise<unknown>) => Promise<void>;
  onAskPurge: () => void;
}

function NoteRow({ note: n, tab, query, compact, run, onAskPurge }: RowProps) {
  const open = () => {
    if (tab === "active") void run(() => commands.showNote(n.id));
  };
  const name = rowName(n);
  const title = (
    <>
      {n.private && (
        <span className="dn-row-private" role="img" aria-label="Private" title="Private">
          <Icon name="lock" size={13} />
        </span>
      )}
      {name ? highlight(name, query) : <em>Empty note</em>}
    </>
  );
  const eye = (
    <button
      type="button"
      className={`dn-app-icon-btn${n.visible ? "" : " is-muted"}`}
      aria-label={n.visible ? "Hide from desktop" : "Show on desktop"}
      title={n.visible ? "Hide from desktop" : "Show on desktop"}
      onClick={(e) => {
        e.stopPropagation();
        void run(() => (n.visible ? commands.hideNote(n.id) : commands.showNote(n.id)));
      }}
    >
      <Icon name={n.visible ? "eye" : "eyeoff"} size={compact ? 15 : 16} />
    </button>
  );
  const stop = (fn: () => void) => (e: MouseEvent) => {
    e.stopPropagation();
    fn();
  };

  if (compact) {
    return (
      <div role="listitem" tabIndex={0} className="dn-row is-compact" onClick={open} onKeyDown={(e) => e.key === "Enter" && open()}>
        <span className="dn-row-dot" style={{ background: n.color }} />
        <span className="dn-row-title">{title}</span>
        <span className="dn-row-time">{listDateLabel(n.updatedAt)}</span>
        {eye}
      </div>
    );
  }

  return (
    <div
      role="listitem"
      tabIndex={0}
      className={`dn-row${tab === "active" ? " is-openable" : ""}`}
      onClick={open}
      onKeyDown={(e) => e.key === "Enter" && open()}
    >
      <span className="dn-row-dot" style={{ background: n.color }} />
      <div className="dn-row-text">
        <span className={`dn-row-title${name ? "" : " is-empty"}`}>{title}</span>
        {n.snippet && !n.locked && query.trim() ? (
          <span className="dn-row-meta">{highlight(n.snippet, query)}</span>
        ) : (
          <span className="dn-row-meta">{rowMeta(n, tab)}</span>
        )}
      </div>
      {tab === "active" && (
        <>
          <span className="dn-row-hover">
            <button type="button" className="dn-app-icon-btn" aria-label="Archive" title="Archive" onClick={stop(() => void run(() => commands.setArchived(n.id, true)))}>
              <Icon name="archive" />
            </button>
            <button type="button" className="dn-app-icon-btn" aria-label="Move to trash" title="Move to trash" onClick={stop(() => void run(() => commands.trashNote(n.id)))}>
              <Icon name="trash" />
            </button>
          </span>
          {eye}
        </>
      )}
      {tab === "completed" && (
        <>
          <span className="dn-row-hover">
            <button type="button" className="dn-app-icon-btn" aria-label="Move to trash" title="Move to trash" onClick={stop(() => void run(() => commands.trashNote(n.id)))}>
              <Icon name="trash" />
            </button>
          </span>
          <button type="button" className="dn-btn-outline" onClick={stop(() => void run(() => commands.setNoteCompleted(n.id, false)))}>
            <Icon name="restore" size={14} />
            Reopen
          </button>
        </>
      )}
      {tab === "archived" && (
        <>
          <span className="dn-row-hover">
            <button type="button" className="dn-app-icon-btn" aria-label="Move to trash" title="Move to trash" onClick={stop(() => void run(() => commands.trashNote(n.id)))}>
              <Icon name="trash" />
            </button>
          </span>
          <button type="button" className="dn-btn-outline" onClick={stop(() => void run(() => commands.setArchived(n.id, false)))}>
            <Icon name="restore" size={14} />
            Unarchive
          </button>
        </>
      )}
      {tab === "trash" && (
        <>
          <button type="button" className="dn-btn-outline" onClick={stop(() => void run(() => commands.restoreNote(n.id)))}>
            <Icon name="restore" size={14} />
            Restore
          </button>
          <button type="button" className="dn-btn-text-danger" onClick={stop(onAskPurge)}>
            Delete permanently
          </button>
        </>
      )}
    </div>
  );
}

function PurgeConfirm({
  note,
  onCancel,
  onDelete,
}: {
  note: NoteSummary;
  onCancel: () => void;
  onDelete: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => cancelRef.current?.focus(), []);
  return (
    <div className="dn-purge" role="listitem">
      <div className="dn-purge-head">
        <span className="dn-row-dot" style={{ background: note.color }} />
        <span className="dn-row-title">{rowName(note) || "Empty note"}</span>
      </div>
      <div className="dn-purge-actions" role="alertdialog" aria-label="Confirm permanent deletion">
        <span>Delete forever? This cannot be undone.</span>
        <button ref={cancelRef} type="button" className="dn-btn-white" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="dn-btn-danger" onClick={onDelete}>
          Delete
        </button>
      </div>
    </div>
  );
}

function EmptyState({
  tab,
  searching,
  onCreate,
}: {
  tab: ManagerTab;
  searching: boolean;
  onCreate: () => void;
}) {
  if (searching) {
    return (
      <div className="dn-empty is-search">
        <span className="dn-empty-badge">
          <Icon name="search" size={20} />
        </span>
        <div className="dn-empty-title">{tab === "reminders" ? "No reminders match your search" : "No notes match your search"}</div>
        <div className="dn-empty-sub">
          {tab === "active" ? "Completed, archived and trashed notes are not included." : "Try another tab or other words."}
        </div>
      </div>
    );
  }
  if (tab === "reminders") {
    return (
      <div className="dn-empty is-quiet">
        <Icon name="bell" size={18} />
        <span>No reminders.</span>
      </div>
    );
  }
  if (tab === "active") {
    return (
      <div className="dn-empty is-active">
        <div className="dn-empty-title">No notes yet. Press Ctrl+N to create one.</div>
        <button type="button" className="dn-btn-accent is-small" onClick={onCreate}>
          <Icon name="plus" stroke={2.75} />
          New note
        </button>
      </div>
    );
  }
  return (
    <div className="dn-empty is-quiet">
      <Icon name={tab === "completed" ? "check" : tab === "archived" ? "archive" : "trash"} size={18} />
      <span>{tab === "completed" ? "Nothing completed yet." : tab === "archived" ? "Nothing archived." : "The trash is empty."}</span>
    </div>
  );
}
