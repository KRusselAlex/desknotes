import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import type { EditorView } from "@tiptap/pm/view";
import { commands } from "../../ipc/commands";
import { onAppWillQuit, onNotesChanged } from "../../ipc/events";
import { onCloseRequested, openExternal } from "../../ipc/window";
import type { Note } from "../../types/note";
import { COLOR_PRESETS, INK, headerShade } from "../appearance/colors";
import { Autosave, type SaveState } from "./autosave";
import { createExtensions, sanitizeDoc } from "./extensions";
import { LinkEditor } from "./LinkEditor";
import { isSafeLink } from "./links";
import { SaveStatus } from "./SaveStatus";
import { FormatToolbar } from "./Toolbar";

type Popover = "none" | "color" | "menu" | "link";

export function NoteWindow({ noteId }: { noteId: string }) {
  const [note, setNote] = useState<Note | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    commands.getNote(noteId).then(setNote, (e: Error) => setLoadError(e.message));
  }, [noteId]);

  if (loadError) {
    return (
      <div className="note-load-error" role="alert">
        <p>This note could not be opened. Its content has not been changed.</p>
        <p className="detail">{loadError}</p>
        <button type="button" onClick={() => void commands.showManager()}>
          Open manager
        </button>
      </div>
    );
  }
  if (!note) return <div className="note-loading" aria-busy="true" />;
  return <LoadedNote note={note} />;
}

function LoadedNote({ note }: { note: Note }) {
  const [color, setColor] = useState(note.color);
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [popover, setPopover] = useState<Popover>("none");
  const closing = useRef(false);

  const autosave = useMemo(
    () =>
      new Autosave({
        save: async (content) => {
          await commands.saveNoteContent(note.id, content);
        },
        onStateChange: (state) => setSaveState(state),
      }),
    [note.id],
  );

  const editor = useEditor({
    extensions: createExtensions(),
    content: note.content,
    editable: !note.editLocked,
    autofocus: note.title === "" ? "end" : false,
    onUpdate: ({ editor: e }) => autosave.change(JSON.stringify(sanitizeDoc(e.getJSON()))),
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
  const hide = useCallback(async () => {
    if (closing.current) return;
    closing.current = true;
    await autosave.flush();
    if (autosave.currentState === "error") {
      closing.current = false;
      return;
    }
    autosave.dispose();
    await commands.hideNote(note.id);
  }, [autosave, note.id]);

  // Window-manager close (Alt+F4, title bar) goes through the same path.
  useEffect(() => {
    const unlisten = onCloseRequested(() => void hide());
    return () => void unlisten.then((f) => f());
  }, [hide]);

  // Flush when the window loses focus (e.g. clicking Quit in the manager)
  // and when the app announces it is quitting.
  useEffect(() => {
    const onBlur = () => void autosave.flush();
    window.addEventListener("blur", onBlur);
    const unlisten = onAppWillQuit(() => void autosave.flush());
    return () => {
      window.removeEventListener("blur", onBlur);
      void unlisten.then((f) => f());
    };
  }, [autosave]);

  // Colour changed from another window.
  useEffect(() => {
    const unlisten = onNotesChanged(({ id, kind }) => {
      if (kind !== "content" && (id === null || id === note.id)) {
        commands.getNote(note.id).then((n) => setColor(n.color), () => undefined);
      }
    });
    return () => void unlisten.then((f) => f());
  }, [note.id]);

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
      } else if (key === "k") {
        e.preventDefault();
        setPopover("link");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [hide]);

  async function pickColor(value: string) {
    setColor(value);
    setPopover("none");
    await commands.setNoteColor(note.id, value);
  }

  async function act(action: () => Promise<unknown>) {
    setPopover("none");
    await autosave.flush();
    await action();
  }

  return (
    <div
      className="note"
      style={{ background: color, color: INK, ["--note-header" as string]: headerShade(color) }}
    >
      <header className="note-header" data-tauri-drag-region>
        <span className="grip" aria-hidden="true" data-tauri-drag-region>
          ⠿
        </span>
        {editor && <FormatToolbar editor={editor} onLink={() => setPopover("link")} />}
        <div className="note-actions">
          <button
            type="button"
            className="tool"
            aria-label="Note colour"
            aria-expanded={popover === "color"}
            onClick={() => setPopover(popover === "color" ? "none" : "color")}
          >
            🎨
          </button>
          <button
            type="button"
            className="tool"
            aria-label="More actions"
            aria-expanded={popover === "menu"}
            onClick={() => setPopover(popover === "menu" ? "none" : "menu")}
          >
            ⋯
          </button>
          <button type="button" className="tool" aria-label="Hide note" title="Hide note (Ctrl+W)" onClick={() => void hide()}>
            ✕
          </button>
        </div>
      </header>

      {popover === "color" && (
        <div className="popover color-grid" role="group" aria-label="Note colour">
          {COLOR_PRESETS.map((p) => (
            <button
              key={p.value}
              type="button"
              className="swatch"
              style={{ background: p.value }}
              aria-label={p.name}
              aria-pressed={p.value === color}
              onClick={() => void pickColor(p.value)}
            />
          ))}
        </div>
      )}

      {popover === "menu" && (
        <div className="popover menu" role="menu">
          <button role="menuitem" type="button" onClick={() => void act(commands.createNote)}>
            New note <kbd>Ctrl+N</kbd>
          </button>
          <button role="menuitem" type="button" onClick={() => void act(() => commands.duplicateNote(note.id))}>
            Duplicate
          </button>
          <button role="menuitem" type="button" onClick={() => void act(commands.showManager)}>
            Open manager
          </button>
          <button role="menuitem" type="button" onClick={() => void act(() => commands.setArchived(note.id, true))}>
            Archive
          </button>
          <button role="menuitem" type="button" onClick={() => void act(() => commands.trashNote(note.id))}>
            Move to trash
          </button>
        </div>
      )}

      {popover === "link" && editor && <LinkEditor editor={editor} onClose={() => setPopover("none")} />}

      <EditorContent editor={editor} className="note-body" onClick={() => setPopover((p) => (p === "link" ? p : "none"))} />

      <SaveStatus state={saveState} onRetry={() => void autosave.flush()} />
    </div>
  );
}
