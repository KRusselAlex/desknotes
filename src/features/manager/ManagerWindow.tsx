import { Fragment, useCallback, useEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { dateGroup, listDateLabel } from "../../app/time";
import { useWindowSize } from "../../app/useWindowSize";
import { Icon } from "../../components/Icon";
import { Menu } from "../../components/Menu";
import { commands } from "../../ipc/commands";
import { onNotesChanged, onQuitBlocked } from "../../ipc/events";
import type { NoteCounts, NoteFilter, NoteSummary } from "../../types/note";

const TABS: { id: NoteFilter; label: string }[] = [
  { id: "active", label: "Active" },
  { id: "archived", label: "Archived" },
  { id: "trash", label: "Trash" },
];

/** Above this many notes the list switches to compact rows grouped by date (design M7). */
const GROUP_THRESHOLD = 12;
/** Below this width the New note button drops its label (design M3). */
const COMPACT_WIDTH = 480;

/** Highlight the first case-insensitive occurrence of `query` in `text`. */
export function highlight(text: string, query: string): ReactNode {
  const q = query.trim().toLowerCase();
  const i = q ? text.toLowerCase().indexOf(q) : -1;
  if (i < 0) return text;
  return (
    <>
      {text.slice(0, i)}
      <mark>{text.slice(i, i + q.length)}</mark>
      {text.slice(i + q.length)}
    </>
  );
}

export function ManagerWindow() {
  const [tab, setTab] = useState<NoteFilter>("active");
  const [query, setQuery] = useState("");
  const [notes, setNotes] = useState<NoteSummary[] | null>(null);
  const [counts, setCounts] = useState<NoteCounts | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [startupErrors, setStartupErrors] = useState<string[]>([]);
  const [confirmPurge, setConfirmPurge] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const { width } = useWindowSize();
  const searching = query.trim() !== "";

  const refresh = useCallback(async () => {
    try {
      const [list, c] = await Promise.all([commands.listNotes(tab, query), commands.noteCounts()]);
      setNotes(list);
      setCounts(c);
      setError(null);
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
    return () => void unlisten.then((f) => f());
  }, [refresh]);

  useEffect(() => {
    commands.startupErrors().then(setStartupErrors, () => undefined);
    const unlisten = onQuitBlocked((count) =>
      setError(
        `DeskNotes did not quit: ${count} ${count === 1 ? "note has" : "notes have"} unsaved text. ` +
          "Look for the note showing \"Not saved\" and press Retry.",
      ),
    );
    return () => void unlisten.then((f) => f());
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
      setError((e as Error).message);
    }
  }

  const banner = error ?? startupErrors[0] ?? null;
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
                { id: "settings", label: "Settings…", icon: "settings", onSelect: () => void commands.openSettings() },
                { id: "quit", label: "Quit DeskNotes", icon: "quit", separatorBefore: true, onSelect: () => void commands.quitApp() },
              ]}
            />
          )}
        </div>
      </div>

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
            {counts && counts[t.id] > 0 && <span className="dn-tab-count">{counts[t.id]}</span>}
          </button>
        ))}
      </div>

      {searching && notes && notes.length > 0 && (
        <div className="dn-search-info">
          {notes.length} {notes.length === 1 ? "note" : "notes"} in {TABS.find((t) => t.id === tab)?.label}
        </div>
      )}

      {notes === null ? (
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
  const title = n.title ? highlight(n.title, query) : <em>Empty note</em>;
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
        <span className={`dn-row-title${n.title ? "" : " is-empty"}`}>{title}</span>
        {n.snippet && query.trim() ? (
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
        <span className="dn-row-title">{note.title || "Empty note"}</span>
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
  tab: NoteFilter;
  searching: boolean;
  onCreate: () => void;
}) {
  if (searching) {
    return (
      <div className="dn-empty is-search">
        <span className="dn-empty-badge">
          <Icon name="search" size={20} />
        </span>
        <div className="dn-empty-title">No notes match your search</div>
        <div className="dn-empty-sub">
          {tab === "active" ? "Archived and trashed notes are not included." : "Try another tab or other words."}
        </div>
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
      <Icon name={tab === "archived" ? "archive" : "trash"} size={18} />
      <span>{tab === "archived" ? "Nothing archived." : "The trash is empty."}</span>
    </div>
  );
}
