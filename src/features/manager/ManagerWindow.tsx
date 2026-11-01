import { useCallback, useEffect, useState } from "react";
import { commands } from "../../ipc/commands";
import { onNotesChanged } from "../../ipc/events";
import type { NoteFilter, NoteSummary } from "../../types/note";

const TABS: { id: NoteFilter; label: string }[] = [
  { id: "active", label: "Active" },
  { id: "archived", label: "Archived" },
  { id: "trash", label: "Trash" },
];

const timeFmt = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });
const dateFmt = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: "numeric" });

export function formatEdited(ms: number, now = Date.now()): string {
  const d = new Date(ms);
  const sameDay = new Date(now).toDateString() === d.toDateString();
  return sameDay ? timeFmt.format(d) : dateFmt.format(d);
}

export function ManagerWindow() {
  const [tab, setTab] = useState<NoteFilter>("active");
  const [query, setQuery] = useState("");
  const [notes, setNotes] = useState<NoteSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [confirmPurge, setConfirmPurge] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setNotes(await commands.listNotes(tab, query));
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
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "n") {
        e.preventDefault();
        void run(commands.createNote);
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

  return (
    <div className="manager">
      <header className="manager-top">
        <button type="button" className="primary" onClick={() => void run(commands.createNote)}>
          + New note
        </button>
        <input
          type="search"
          aria-label="Search notes"
          placeholder="Search notes"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button type="button" onClick={() => void commands.quitApp()}>
          Quit
        </button>
      </header>

      <div className="tabs" role="tablist" aria-label="Note lists">
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
          </button>
        ))}
      </div>

      {error && (
        <div className="banner-error" role="alert">
          {error}
        </div>
      )}

      {notes.length === 0 ? (
        <p className="empty">
          {query
            ? "No notes match your search."
            : { active: "No notes yet. Press Ctrl+N to create one.", archived: "Nothing archived.", trash: "The trash is empty." }[tab]}
        </p>
      ) : (
        <ul className="note-list" aria-label={`${tab} notes`}>
          {notes.map((n) => (
            <li key={n.id} className="note-row">
              <span className="row-color" style={{ background: n.color }} aria-hidden="true" />
              <span className="row-title">{n.title || <em>Empty note</em>}</span>
              <span className="row-time">{formatEdited(n.updatedAt)}</span>
              <span className="row-actions">
                {tab === "active" &&
                  (n.visible ? (
                    <button type="button" onClick={() => void run(() => commands.hideNote(n.id))}>
                      Hide
                    </button>
                  ) : (
                    <button type="button" onClick={() => void run(() => commands.showNote(n.id))}>
                      Show
                    </button>
                  ))}
                {tab === "active" && (
                  <button type="button" onClick={() => void run(() => commands.setArchived(n.id, true))}>
                    Archive
                  </button>
                )}
                {tab === "archived" && (
                  <button type="button" onClick={() => void run(() => commands.setArchived(n.id, false))}>
                    Unarchive
                  </button>
                )}
                {tab !== "trash" && (
                  <button type="button" onClick={() => void run(() => commands.trashNote(n.id))}>
                    Move to trash
                  </button>
                )}
                {tab === "trash" && confirmPurge !== n.id && (
                  <>
                    <button type="button" onClick={() => void run(() => commands.restoreNote(n.id))}>
                      Restore
                    </button>
                    <button type="button" className="danger" onClick={() => setConfirmPurge(n.id)}>
                      Delete permanently
                    </button>
                  </>
                )}
                {tab === "trash" && confirmPurge === n.id && (
                  <span className="confirm" role="alertdialog" aria-label="Confirm permanent deletion">
                    Delete forever? This cannot be undone.
                    <button type="button" onClick={() => setConfirmPurge(null)}>
                      Cancel
                    </button>
                    <button
                      type="button"
                      className="danger"
                      onClick={() =>
                        void run(async () => {
                          setConfirmPurge(null);
                          await commands.purgeNote(n.id);
                        })
                      }
                    >
                      Delete
                    </button>
                  </span>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
