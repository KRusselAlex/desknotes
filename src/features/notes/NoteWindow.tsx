import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import type { EditorView } from "@tiptap/pm/view";
import { noteDateLabel } from "../../app/time";
import { useWindowSize } from "../../app/useWindowSize";
import { Icon } from "../../components/Icon";
import { Menu, type MenuItem } from "../../components/Menu";
import { commands } from "../../ipc/commands";
import { onSaveAllRequest, onNoteAction, onNotesChanged } from "../../ipc/events";
import { onCloseRequested, openExternal } from "../../ipc/window";
import type { Note } from "../../types/note";
import { headerShade } from "../appearance/colors";
import { Autosave, type SaveState } from "./autosave";
import { ColorPopover } from "./ColorPopover";
import { createExtensions, serializeDoc } from "./extensions";
import { FormatBar } from "./FormatBar";
import { LinkEditor } from "./LinkEditor";
import { LinkHint } from "./LinkHint";
import { isSafeLink } from "./links";
import { SaveError, SaveIndicator } from "./SaveStatus";

/** Below this width the date hides and the bar keeps only List, B, I, Link. */
const NARROW = 260;
/** Below this height the formatting bar does not fit (minimum note is 120). */
const SHORT = 160;

type Popover = "none" | "color" | "menu" | "link";

function noteStyle(color: string): CSSProperties {
  return { "--note-bg": color, "--note-hd": headerShade(color) } as CSSProperties;
}

export function NoteWindow({ noteId }: { noteId: string }) {
  const [note, setNote] = useState<Note | null>(null);
  const [loadError, setLoadError] = useState(false);

  useEffect(() => {
    commands.getNote(noteId).then(setNote, () => setLoadError(true));
  }, [noteId]);

  if (loadError) return <NoteLoadError noteId={noteId} color="#efe6d8" />;
  if (!note) return <div className="dn-note" aria-busy="true" style={noteStyle("#fff4a3")} />;
  return <LoadedNote note={note} />;
}

/** Design N7: keeps a note look, header still drags and hides. */
function NoteLoadError({ noteId, color }: { noteId: string; color: string }) {
  return (
    <div className="dn-note" style={noteStyle(color)}>
      <header className="dn-note-header" data-tauri-drag-region>
        <span className="dn-grip" data-tauri-drag-region>
          <Icon name="grip" size={14} />
        </span>
        <span className="dn-spacer" data-tauri-drag-region />
        <button type="button" className="dn-tool" aria-label="Hide note" onClick={() => void commands.hideNote(noteId)}>
          <Icon name="close" />
        </button>
      </header>
      <div className="dn-note-failed" role="alert">
        <span className="dn-failed-icon">
          <Icon name="alert" size={20} />
        </span>
        <div className="dn-failed-title">This note could not be opened.</div>
        <button type="button" className="dn-pill-ink" onClick={() => void commands.showManager()}>
          Open manager
        </button>
      </div>
    </div>
  );
}

function LoadedNote({ note }: { note: Note }) {
  const [color, setColor] = useState(note.color);
  const [updatedAt, setUpdatedAt] = useState(note.updatedAt);
  const [title, setTitle] = useState(note.title);
  const [pinned, setPinned] = useState(note.window.alwaysOnTop);
  const [collapsed, setCollapsedView] = useState(note.window.collapsed);
  const [locked, setLocked] = useState(note.editLocked);
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [saveErrorReason, setSaveErrorReason] = useState<string>();
  const [popover, setPopover] = useState<Popover>("none");
  const [focused, setFocused] = useState(false);
  const [, setTick] = useState(0); // refreshes the relative date chip
  const [bodyEl, setBodyEl] = useState<HTMLDivElement | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const closing = useRef(false);
  /** Last content known to be saved (or loaded); avoids writes when nothing changed. */
  const lastContent = useRef<string | null>(null);
  /** Set when stored content could not be loaded: never autosave over it. */
  const contentBroken = useRef(false);
  const [contentError, setContentError] = useState(false);
  const { width, height } = useWindowSize();
  const narrow = width < NARROW;

  const autosave = useMemo(
    () =>
      new Autosave({
        save: async (content) => {
          const result = await commands.saveNoteContent(note.id, content);
          setUpdatedAt(result.updatedAt);
          setTitle(result.title);
        },
        onStateChange: (state, error) => {
          setSaveState(state);
          setSaveErrorReason(error);
        },
      }),
    [note.id],
  );

  const editor = useEditor({
    extensions: createExtensions(),
    content: note.content,
    editable: !note.editLocked,
    // Refuse content the editor cannot represent instead of silently loading an
    // empty note (which the next keystroke would save over the real one).
    enableContentCheck: true,
    onContentError: () => {
      contentBroken.current = true;
      setContentError(true);
    },
    autofocus: note.title === "" && !note.editLocked ? "end" : false,
    onCreate: ({ editor: e }) => {
      lastContent.current = serializeDoc(e.getJSON());
    },
    onUpdate: ({ editor: e }) => {
      if (contentBroken.current) return;
      const content = serializeDoc(e.getJSON());
      if (content === lastContent.current) return;
      lastContent.current = content;
      autosave.change(content);
    },
    onBlur: () => void autosave.flush(),
    editorProps: {
      attributes: { "aria-label": "Note text", spellcheck: "true" },
      handleClick: (_view: EditorView, _pos: number, event: MouseEvent) => {
        const anchor = (event.target as HTMLElement | null)?.closest("a");
        if (!anchor) return false;
        event.preventDefault();
        if (event.ctrlKey || event.metaKey) {
          const href = anchor.getAttribute("href") ?? "";
          if (isSafeLink(href)) void openExternal(href);
          return true;
        }
        return false;
      },
    },
  });

  /** Save, then hide the window. Stays open if the save failed. */
  /** Save first; run `action` only if everything is saved. Returns false otherwise. */
  const saveThen = useCallback(
    async (action: () => Promise<unknown>): Promise<boolean> => {
      await autosave.flush();
      if (autosave.currentState === "error") return false; // the error message stays visible
      await action();
      return true;
    },
    [autosave],
  );

  /** Save, then hide the window. Stays open if the save failed. */
  const hide = useCallback(async () => {
    if (closing.current) return;
    closing.current = true;
    try {
      const done = await saveThen(() => commands.hideNote(note.id));
      if (done) autosave.dispose();
    } finally {
      closing.current = false;
    }
  }, [autosave, note.id, saveThen]);

  // The manager asked to hide, archive or trash this note: save first, here.
  useEffect(() => {
    const unlisten = onNoteAction((action) => {
      if (action === "hide") void hide();
      else if (action === "archive") void saveThen(() => commands.setArchived(note.id, true));
      else if (action === "trash") void saveThen(() => commands.trashNote(note.id));
    });
    return () => void unlisten.then((f) => f());
  }, [hide, note.id, saveThen]);

  useEffect(() => {
    const unlisten = onCloseRequested(() => void hide());
    return () => void unlisten.then((f) => f());
  }, [hide]);

  // Flush when focus leaves the window and when the app is quitting.
  useEffect(() => {
    const onBlur = () => void autosave.flush();
    window.addEventListener("blur", onBlur);
    const unlisten = onSaveAllRequest(() => {
      void autosave
        .flush()
        .then(() => commands.quitReady(autosave.currentState !== "error"))
        .catch(() => undefined);
    });
    return () => {
      window.removeEventListener("blur", onBlur);
      void unlisten.then((f) => f());
    };
  }, [autosave]);

  // Changes made from another window (colour, lock).
  useEffect(() => {
    const unlisten = onNotesChanged(({ id, kind }) => {
      if (kind !== "content" && (id === null || id === note.id)) {
        commands.getNote(note.id).then(
          (n) => {
            setColor(n.color);
            setLocked(n.editLocked);
            setPinned(n.window.alwaysOnTop);
            setCollapsedView(n.window.collapsed);
          },
          () => undefined,
        );
      }
    });
    return () => void unlisten.then((f) => f());
  }, [note.id]);

  useEffect(() => {
    // false: changing editability is not a content change, so do not emit an update.
    editor?.setEditable(!locked, false);
  }, [editor, locked]);

  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);

  // Close popovers on outside click or Escape.
  useEffect(() => {
    if (popover === "none" || popover === "link") return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as HTMLElement;
      if (!t.closest(".dn-popover") && !t.closest("[data-popover-toggle]")) setPopover("none");
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [popover]);

  const closePopover = useCallback(() => {
    setPopover("none");
    editor?.commands.focus();
  }, [editor]);

  async function setEditLock(value: boolean) {
    if (value) await autosave.flush();
    await commands.setEditLocked(note.id, value);
    setLocked(value);
    if (!value) editor?.commands.focus("end");
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      const key = e.key.toLowerCase();
      if (key === "n" && !e.shiftKey) {
        e.preventDefault();
        void commands.createNote();
      } else if (key === "w") {
        e.preventDefault();
        void hide();
      } else if (key === "k" && !locked) {
        e.preventDefault();
        setPopover("link");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [hide, locked]);

  async function act(action: () => Promise<unknown>) {
    await saveThen(action);
  }

  async function togglePinned() {
    const next = !pinned;
    setPinned(next);
    try {
      await commands.setAlwaysOnTop(note.id, next);
    } catch {
      setPinned(!next);
    }
  }

  /** Collapse only after the text is saved; expanding never needs a save. */
  async function setCollapsed(next: boolean) {
    setPopover("none");
    const run = () => commands.setCollapsed(note.id, next).then(() => setCollapsedView(next));
    if (next) await saveThen(run);
    else await run();
  }

  const menuItems: MenuItem[] = [
    { id: "new", label: "New note", icon: "plus", shortcut: "Ctrl+N", onSelect: () => void commands.createNote() },
    {
      id: "lock",
      label: locked ? "Allow editing" : "Lock editing",
      icon: "editlock",
      onSelect: () => void setEditLock(!locked),
    },
    { id: "dup", label: "Duplicate", icon: "duplicate", onSelect: () => void act(() => commands.duplicateNote(note.id)) },
    {
      id: "pin",
      label: "Always on top",
      icon: "pin",
      checkable: true,
      checked: pinned,
      onSelect: () => void togglePinned(),
    },
    { id: "manager", label: "Open manager", icon: "note", separatorBefore: true, onSelect: () => void commands.showManager() },
    { id: "archive", label: "Archive", icon: "archive", separatorBefore: true, onSelect: () => void act(() => commands.setArchived(note.id, true)) },
    { id: "trash", label: "Move to trash", icon: "trash", danger: true, onSelect: () => void act(() => commands.trashNote(note.id)) },
  ];

  if (contentError) return <NoteLoadError noteId={note.id} color={color} />;

  const pinButton = pinned && (
    <button
      type="button"
      className="dn-pin-on"
      aria-label="Always on top is on"
      title="Always on top · click to turn off"
      aria-pressed="true"
      onClick={() => void togglePinned()}
    >
      <Icon name="pin" size={13} />
    </button>
  );

  // Design B3: the note rolled up to its header strip. The editor stays mounted
  // (hidden) so nothing typed can be lost while collapsed.
  if (collapsed) {
    return (
      <div className="dn-note is-collapsed" style={noteStyle(color)}>
        <div className="dn-collapsed-strip" data-tauri-drag-region onDoubleClick={() => void setCollapsed(false)}>
          <button
            type="button"
            className="dn-tool"
            aria-label="Expand"
            aria-expanded="false"
            title="Expand"
            onClick={() => void setCollapsed(false)}
          >
            <Icon name="chevright" />
          </button>
          <span className="dn-collapsed-title" data-tauri-drag-region>
            {title || "Empty note"}
          </span>
          {!narrow && (
            <span className="dn-note-date" data-tauri-drag-region>
              {noteDateLabel(updatedAt)}
            </span>
          )}
          {pinButton}
        </div>
        <div hidden>
          <EditorContent editor={editor} />
        </div>
      </div>
    );
  }

  const editing = focused && !locked;
  const showBar = editing && height >= SHORT && editor !== null;

  return (
    <div
      ref={rootRef}
      className={`dn-note${locked ? " is-readonly" : ""}${editing ? " is-editing" : ""}`}
      style={noteStyle(color)}
      onFocus={() => setFocused(true)}
      onBlur={(e) => {
        if (!rootRef.current?.contains(e.relatedTarget as Node | null)) setFocused(false);
      }}
    >
      <header className="dn-note-header" data-tauri-drag-region>
        <span className="dn-grip" data-tauri-drag-region>
          <Icon name="grip" size={14} />
        </span>
        {locked && (
          <button
            type="button"
            className="dn-readonly-chip"
            title="Read-only. Click to allow editing."
            onClick={() => void setEditLock(false)}
          >
            <Icon name="editlock" size={13} />
            Read-only
          </button>
        )}
        <div className="dn-note-controls">
          <button
            type="button"
            className="dn-tool"
            aria-label="Collapse note"
            aria-expanded="true"
            title="Collapse to header"
            onClick={() => void setCollapsed(true)}
          >
            <Icon name="chevdown" />
          </button>
          {!narrow && !locked && <span className="dn-note-date" data-tauri-drag-region>{noteDateLabel(updatedAt)}</span>}
          <span className="dn-spacer" data-tauri-drag-region />
          {pinned ? (
            pinButton
          ) : (
            <button
              type="button"
              className="dn-tool"
              aria-label="Always on top"
              aria-pressed="false"
              title="Keep above other windows"
              onClick={() => void togglePinned()}
            >
              <Icon name="pin" />
            </button>
          )}
          {!locked && (
            <button
              type="button"
              className="dn-tool"
              aria-label="Colour"
              title="Colour"
              aria-expanded={popover === "color"}
              data-popover-toggle
              onClick={() => setPopover(popover === "color" ? "none" : "color")}
            >
              <Icon name="colour" />
            </button>
          )}
          <button
            type="button"
            className="dn-tool"
            aria-label="More"
            title="More"
            aria-haspopup="menu"
            aria-expanded={popover === "menu"}
            data-popover-toggle
            onClick={() => setPopover(popover === "menu" ? "none" : "menu")}
          >
            <Icon name="more" />
          </button>
          <button type="button" className="dn-tool" aria-label="Hide note" title="Hide note (Ctrl+W)" onClick={() => void hide()}>
            <Icon name="close" />
          </button>
        </div>
      </header>

      {popover === "color" && (
        <ColorPopover
          current={color}
          onClose={closePopover}
          onPick={(value) => {
            setColor(value);
            closePopover();
            void commands.setNoteColor(note.id, value);
          }}
        />
      )}
      {popover === "menu" && <Menu label="Note actions" items={menuItems} onClose={closePopover} className="dn-note-menu" />}
      {popover === "link" && editor && <LinkEditor editor={editor} onClose={() => setPopover("none")} />}

      <div className="dn-note-body" ref={setBodyEl}>
        <EditorContent editor={editor} />
        <SaveIndicator state={saveState} editing={editing} />
      </div>
      <LinkHint container={bodyEl} />

      {saveState === "error" && <SaveError reason={saveErrorReason} onRetry={() => void autosave.flush()} />}
      {showBar && editor && (
        <FormatBar editor={editor} narrow={narrow} onLink={() => setPopover("link")} />
      )}
      {!showBar && saveState !== "error" && (
        <span className="dn-resize-mark" aria-hidden="true">
          <Icon name="resize" size={12} />
        </span>
      )}
    </div>
  );
}
