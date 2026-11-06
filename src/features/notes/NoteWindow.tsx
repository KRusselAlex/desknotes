import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import type { EditorView } from "@tiptap/pm/view";
import { noteDateLabel } from "../../app/time";
import { useWindowSize } from "../../app/useWindowSize";
import { Icon } from "../../components/Icon";
import { Menu, type MenuItem, type QuickAction } from "../../components/Menu";
import { commands } from "../../ipc/commands";
import {
  onImagesDropped,
  onSaveAllRequest,
  onNoteAction,
  onNotesChanged,
  onPrivacyChanged,
  onRemindersChanged,
} from "../../ipc/events";
import { onCloseRequested, openExternal } from "../../ipc/window";
import { PRIVATE_FALLBACK_LABEL, type AppAppearance, type Appearance, type Note } from "../../types/note";
import type { ReminderView } from "../../types/reminder";
import {
  APPEARANCE_DEFAULTS,
  appClasses,
  appearanceStyle,
  effectiveAppearance,
  isSeeThrough,
  seeThroughClass,
} from "../appearance/appearance";
import { useAppAppearance } from "../appearance/useAppAppearance";
import { ForgotPin } from "../privacy/ForgotPin";
import { PinPad } from "../privacy/PinPad";
import { PrivateLabelDialog } from "../privacy/PrivateLabelDialog";
import { isLockRefusal, refusalText } from "../privacy/refusal";
import { UnlockDialog } from "../privacy/UnlockDialog";
import { Autosave, type SaveState } from "./autosave";
import { ColorPopover } from "./ColorPopover";
import { DoneStrip } from "./DoneStrip";
import { createExtensions, serializeDoc } from "./extensions";
import { FormatBar } from "./FormatBar";
import {
  addImageFiles,
  imageFilesIn,
  insertDroppedImages,
  pasteFromClipboard,
  pastePoint,
  pasteSource,
  problemOf,
  type ImageProblem,
} from "./imageInput";
import { ImageMessage } from "./ImageMessage";
import { LinkEditor } from "./LinkEditor";
import { LinkHint } from "./LinkHint";
import { isSafeLink } from "./links";
import { chipText } from "./reminderText";
import { ReminderPopover } from "./ReminderPopover";
import { NoteNotice, SaveError, SaveIndicator } from "./SaveStatus";

/** Below this width the date hides and the bar keeps only List, B, I, Link. */
const NARROW = 260;
/** Below this height the formatting bar does not fit (minimum note is 120). */
const SHORT = 160;
/** After a private note answers a save-all request it stays read-only this long,
 * waiting for a lock that may follow (ruling R14). */
export const LOCK_HOLD_MS = 5_000;
/** How long "Marked done" stays undoable before the note is really marked done (DES-39). */
export const DONE_STRIP_MS = 5_000;

type Popover = "none" | "color" | "menu" | "link";

const NO_APPEARANCE: Appearance = {};

/** How often the chip looks again, so "today" and "overdue" stay right while the window is open. */
const REMINDER_REFRESH_MS = 60_000;

/**
 * The note's reminder, read again when it changes (reminders-changed for this note, or for
 * several) and every minute. `null` while it has none, or while it cannot be read.
 */
function useReminder(noteId: string): ReminderView | null {
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

/** The native window is transparent only below 100 % opacity; then the page must be too. */
function useSeeThrough(appearance: Appearance) {
  const see = isSeeThrough(appearance);
  useEffect(() => {
    document.documentElement.classList.toggle("dn-see-through", see);
    return () => document.documentElement.classList.remove("dn-see-through");
  }, [see]);
}

/** Root class and CSS variables of a note: its own values over the app defaults,
 * and the app's high contrast and layout as classes (CSS only, nothing stored). */
function noteLook(color: string, appearance: Appearance, app: AppAppearance) {
  return { classes: appClasses(app), style: appearanceStyle(color, effectiveAppearance(appearance, app)) };
}

export function NoteWindow({ noteId }: { noteId: string }) {
  const [note, setNote] = useState<Note | null>(null);
  const [loadError, setLoadError] = useState(false);
  // Read before anything is drawn, so a note opened after a change never shows the old look.
  const app = useAppAppearance();

  useEffect(() => {
    commands.getNote(noteId).then(setNote, () => setLoadError(true));
  }, [noteId]);

  if (!app || (!note && !loadError)) {
    return <div className="dn-note" aria-busy="true" style={appearanceStyle("#fff4a3", NO_APPEARANCE)} />;
  }
  if (!note) return <NoteLoadError noteId={noteId} color="#efe6d8" appearance={NO_APPEARANCE} app={app} />;
  // A locked private note never mounts the editor; its text never reached this window.
  if (note.locked) return <LockedNote note={note} onNote={setNote} app={app} />;
  return <LoadedNote note={note} onLocked={setNote} app={app} />;
}

/**
 * A private note while the privacy lock is on (design "PIN inside a note"): its
 * colour, its label (never its title) and the window controls, with the PIN pad
 * as the body. `onNote` receives the note again after any change; once it is
 * unlocked the editor mounts with the real text.
 */
function LockedNote({ note, onNote, app }: { note: Note; onNote: (n: Note) => void; app: AppAppearance }) {
  const label = note.privateLabel || PRIVATE_FALLBACK_LABEL;
  const look = noteLook(note.color, note.appearance, app);
  const [forgot, setForgot] = useState(false);
  useSeeThrough(note.appearance);

  const refresh = useCallback(() => {
    commands.getNote(note.id).then(onNote, () => undefined);
  }, [note.id, onNote]);

  useEffect(() => {
    const unlock = onPrivacyChanged(() => refresh());
    const changed = onNotesChanged(({ id, kind }) => {
      if (kind !== "content" && (id === null || id === note.id)) refresh();
    });
    return () => {
      void unlock.then((f) => f());
      void changed.then((f) => f());
    };
  }, [note.id, refresh]);

  // Nothing to save while locked: answer quit, export and lock rounds at once.
  useEffect(() => {
    const unlisten = onSaveAllRequest(() => void commands.quitReady(true).catch(() => undefined));
    return () => void unlisten.then((f) => f());
  }, []);

  const hide = useCallback(() => void commands.hideNote(note.id).catch(() => undefined), [note.id]);

  useEffect(() => {
    const unlisten = onNoteAction((action) => {
      if (action === "hide") hide();
      else if (action === "archive") void commands.setArchived(note.id, true).catch(() => undefined);
      else if (action === "trash") void commands.trashNote(note.id).catch(() => undefined);
      else if (action === "complete") void commands.setNoteCompleted(note.id, true).catch(() => undefined);
      // Nothing to save while locked: the window can be recreated at once (opacity crossed 100 %).
      else if (action === "reopen") void commands.reopenNote(note.id).catch(() => undefined);
    });
    return () => void unlisten.then((f) => f());
  }, [hide, note.id]);

  useEffect(() => {
    const unlisten = onCloseRequested(hide);
    return () => void unlisten.then((f) => f());
  }, [hide]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      const key = e.key.toLowerCase();
      if (key === "n" && !e.shiftKey) {
        e.preventDefault();
        void commands.createNote();
      } else if (key === "w") {
        e.preventDefault();
        hide();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [hide]);

  const pinButton = note.window.alwaysOnTop && (
    <button
      type="button"
      className="dn-pin-on"
      aria-label="Always on top is on"
      title="Always on top · click to turn off"
      aria-pressed="true"
      onClick={() => void commands.setAlwaysOnTop(note.id, false).then(refresh, () => undefined)}
    >
      <Icon name="pin" size={13} />
    </button>
  );

  if (note.window.collapsed) {
    const expand = () => void commands.setCollapsed(note.id, false).then(refresh, () => undefined);
    return (
      <div className={`dn-note is-collapsed${look.classes}`} style={look.style}>
        <div className="dn-collapsed-strip" data-tauri-drag-region onDoubleClick={expand}>
          <button type="button" className="dn-tool" aria-label="Expand" aria-expanded="false" title="Expand" onClick={expand}>
            <Icon name="chevright" />
          </button>
          <span className="dn-collapsed-title" data-tauri-drag-region>
            {label}
          </span>
          {pinButton}
        </div>
      </div>
    );
  }

  return (
    <div className={`dn-note is-private-locked${seeThroughClass(note.appearance)}${look.classes}`} style={look.style}>
      <header className="dn-note-header" data-tauri-drag-region>
        <span className="dn-grip" data-tauri-drag-region>
          <Icon name="grip" size={14} />
        </span>
        <span className="dn-locked-label" data-tauri-drag-region>
          {label}
        </span>
        <div className="dn-note-controls">
          <span className="dn-spacer" data-tauri-drag-region />
          {pinButton}
          <button type="button" className="dn-tool" aria-label="Hide note" title="Hide note (Ctrl+W)" onClick={hide}>
            <Icon name="close" />
          </button>
        </div>
      </header>
      <div className="dn-note-locked">
        {/* Paused under "Forgot your PIN?": digits typed there must never be sent as a PIN. */}
        <PinPad onUnlocked={refresh} onForgot={() => setForgot(true)} paused={forgot} />
      </div>
      {/* Once proved, the lock is off: privacy-changed brings the note back unlocked. */}
      {forgot && <ForgotPin onClose={() => setForgot(false)} />}
    </div>
  );
}

/** Design N7: keeps a note look, header still drags and hides. */
function NoteLoadError({
  noteId,
  color,
  appearance,
  app,
}: {
  noteId: string;
  color: string;
  appearance: Appearance;
  app: AppAppearance;
}) {
  useSeeThrough(appearance);
  const look = noteLook(color, appearance, app);
  return (
    <div className={`dn-note${seeThroughClass(appearance)}${look.classes}`} style={look.style}>
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

function LoadedNote({ note, onLocked, app }: { note: Note; onLocked: (n: Note) => void; app: AppAppearance }) {
  const [color, setColor] = useState(note.color);
  const [appearance, setAppearance] = useState(note.appearance);
  useSeeThrough(appearance);
  /** The note's own values over the app defaults: what is drawn, never what is stored. */
  const shown = useMemo(() => effectiveAppearance(appearance, app), [appearance, app]);
  const look = { classes: appClasses(app), style: appearanceStyle(color, shown) };
  const [updatedAt, setUpdatedAt] = useState(note.updatedAt);
  const [title, setTitle] = useState(note.title);
  const [pinned, setPinned] = useState(note.window.alwaysOnTop);
  const [collapsed, setCollapsedView] = useState(note.window.collapsed);
  const [locked, setLocked] = useState(note.editLocked);
  const [isPrivate, setIsPrivate] = useState(note.private);
  const [privateLabel, setPrivateLabel] = useState(note.privateLabel);
  /** Read by event handlers registered once. */
  const privateRef = useRef(note.private);
  /** Read-only while a privacy lock may be about to replace the editor (R14). */
  const [held, setHeld] = useState(false);
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lockCheck = useRef<Promise<void> | null>(null);
  const [labelDialog, setLabelDialog] = useState<"make" | "rename" | null>(null);
  /** "Unlock to save": the PIN asked for here when the lock refused this note's save (R20). */
  const [unlocking, setUnlocking] = useState(false);
  /** Why the last menu action was refused (R21). */
  const [refusal, setRefusal] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [saveErrorReason, setSaveErrorReason] = useState<string>();
  /** The last save was refused because private notes are locked (its error code, R20). */
  const [saveRefusedByLock, setSaveRefusedByLock] = useState(false);
  const [popover, setPopover] = useState<Popover>("none");
  /** The reminder popover (design R1); apart from `popover` because the menu closes itself after a pick. */
  const [reminderOpen, setReminderOpen] = useState(false);
  const reminder = useReminder(note.id);
  /** Opens one of the header popovers; only one is open at a time. */
  const openPopover = useCallback((next: Popover) => {
    setReminderOpen(false);
    setPopover(next);
  }, []);
  const [focused, setFocused] = useState(false);
  const [, setTick] = useState(0); // refreshes the relative date chip
  const [bodyEl, setBodyEl] = useState<HTMLDivElement | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const closing = useRef(false);
  /** "Marked done" shows for DONE_STRIP_MS; nothing is written until it ends (ruling R1). */
  const [stripShown, setStripShown] = useState(false);
  /** Read by handlers registered once. */
  const stripRef = useRef(false);
  const stripTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** The completion in flight (from the timer, a close or a save-all round); later callers share it. */
  const completing = useRef<Promise<boolean> | null>(null);
  /** Last content known to be saved (or loaded); avoids writes when nothing changed. */
  const lastContent = useRef<string | null>(null);
  /** Set when stored content could not be loaded: never autosave over it. */
  const contentBroken = useRef(false);
  const [contentError, setContentError] = useState(false);
  /** Why the last image was not added; `n` remounts the message, so a new one replaces it. */
  const [imageProblem, setImageProblem] = useState<{ problem: ImageProblem; n: number } | null>(null);
  const showImageProblem = useCallback(
    (problem: ImageProblem) => setImageProblem((old) => ({ problem, n: (old?.n ?? 0) + 1 })),
    [],
  );
  const closeImageProblem = useCallback(() => setImageProblem(null), []);
  /** For the paste and drop handlers, which the editor holds from before it exists. */
  const editorRef = useRef<Editor | null>(null);
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
        onStateChange: (state, message, error) => {
          setSaveState(state);
          setSaveErrorReason(message);
          setSaveRefusedByLock(isLockRefusal(error));
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
      // useEditor re-applies these options on every render, so `dir` follows the note's
      // direction without recreating the editor or touching its content.
      attributes: { "aria-label": "Note text", spellcheck: "true", dir: appearance.direction ?? APPEARANCE_DEFAULTS.direction },
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
      // Image files are pasted when the clipboard's HTML holds nothing but images (a browser's
      // "Copy Image"); an office paste, whose HTML comes with a picture of it, stays text.
      // WebKitGTK shows the page no clipboard image at all, so a paste with nothing usable
      // and no plain text is read in Rust. The images go where the paste was, whatever is
      // typed or selected meanwhile. File drops never reach the webview: Tauri's handler
      // gives them to Rust (`images-dropped` below); moving text stays the editor's.
      handlePaste: (view: EditorView, event: ClipboardEvent) => {
        const data = event.clipboardData;
        const files = imageFilesIn(data?.files);
        const source = pasteSource(Array.from(data?.types ?? []), data?.getData("text/html") ?? "", files);
        if (source === "default") return false;
        if (source === "files") {
          const at = pastePoint(view, files);
          if (editorRef.current) void addImageFiles(editorRef.current, note.id, files, showImageProblem, at);
          return true;
        }
        // Nothing is known to be inserted yet, so a text selection is kept.
        const at = pastePoint(view, []);
        if (editorRef.current) void pasteFromClipboard(editorRef.current, note.id, showImageProblem, at);
        return true;
      },
    },
  });
  useEffect(() => {
    editorRef.current = editor;
  }, [editor]);

  // Files dropped on the window, read and stored by Rust.
  useEffect(() => {
    const unlisten = onImagesDropped(({ images, problem, x, y }) => {
      if (editorRef.current) insertDroppedImages(editorRef.current, images, x, y);
      if (problem) showImageProblem(problemOf({ code: problem }));
    });
    return () => void unlisten.then((f) => f());
  }, [showImageProblem]);

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

  const stopStrip = useCallback(() => {
    if (stripTimer.current) clearTimeout(stripTimer.current);
    stripTimer.current = null;
    stripRef.current = false;
    setStripShown(false);
  }, []);

  useEffect(
    () => () => {
      if (stripTimer.current) clearTimeout(stripTimer.current);
    },
    [],
  );

  /**
   * The strip is over, or the window is closing or the app quitting during it: save any pending
   * text, then mark the note done (the shell closes the window). Only Undo cancels. If the save
   * fails the note stays open and active, with the "Not saved" message; if the command is
   * refused, the reason is shown. Returns whether the note was marked done.
   */
  const completeStrip = useCallback((): Promise<boolean> => {
    stopStrip();
    if (completing.current) return completing.current;
    const run = async (): Promise<boolean> => {
      try {
        const done = await saveThen(() => commands.setNoteCompleted(note.id, true));
        if (done) autosave.dispose();
        else editor?.commands.focus(); // still open: back to the text, with the "Not saved" message
        return done;
      } catch (e) {
        setRefusal(refusalText(e));
        editor?.commands.focus();
        return false;
      }
    };
    const p = run().finally(() => {
      completing.current = null;
    });
    completing.current = p;
    return p;
  }, [autosave, editor, note.id, saveThen, stopStrip]);

  /**
   * "Mark as done": the strip shows, and the timer starts. Ignored while it already shows, the
   * note is going away, or its content could not be loaded (that view has no strip to show, and a
   * timer must never run unseen).
   */
  const startStrip = useCallback(() => {
    if (contentBroken.current || stripRef.current || closing.current || completing.current) return;
    stripRef.current = true;
    setStripShown(true);
    stripTimer.current = setTimeout(() => {
      // A close is already under way (it hides the note): drop the strip rather than leave it up with no timer.
      if (closing.current) {
        stopStrip();
        return;
      }
      void completeStrip();
    }, DONE_STRIP_MS);
  }, [completeStrip, stopStrip]);

  /** Undo, or Ctrl+Z while the strip shows: the note stays as it was, and the editor has focus again. */
  const undoStrip = useCallback(() => {
    stopStrip();
    editor?.commands.focus();
  }, [editor, stopStrip]);

  /** Save, then hide the window. Stays open if the save failed. During the strip, closing marks the note done. */
  const hide = useCallback(async () => {
    if (closing.current) return;
    closing.current = true;
    try {
      if (stripRef.current || completing.current) {
        await completeStrip();
        return;
      }
      const done = await saveThen(() => commands.hideNote(note.id));
      if (done) autosave.dispose();
    } finally {
      closing.current = false;
    }
  }, [autosave, completeStrip, note.id, saveThen]);

  // The manager asked to hide, archive, trash or complete this note: save first, here.
  useEffect(() => {
    const unlisten = onNoteAction((action) => {
      if (action === "hide") void hide();
      else if (action === "archive") void saveThen(() => commands.setArchived(note.id, true));
      else if (action === "trash") void saveThen(() => commands.trashNote(note.id));
      else if (action === "complete") void saveThen(() => commands.setNoteCompleted(note.id, true));
      // The opacity crossed 100 %: the shell recreates this window. Only after the text is saved.
      // A failed reopen is reported by the native side (the manager's error list); nothing to add here.
      else if (action === "reopen") void saveThen(() => commands.reopenNote(note.id)).catch(() => undefined);
    });
    return () => void unlisten.then((f) => f());
  }, [hide, note.id, saveThen]);

  useEffect(() => {
    const unlisten = onCloseRequested(() => void hide());
    return () => void unlisten.then((f) => f());
  }, [hide]);

  const applyPrivacy = useCallback((value: boolean, label: string) => {
    privateRef.current = value;
    setIsPrivate(value);
    setPrivateLabel(label);
  }, []);

  const stopHold = useCallback(() => {
    if (holdTimer.current) clearTimeout(holdTimer.current);
    holdTimer.current = null;
  }, []);

  /** Make the editor read-only now, before React re-renders (no keystroke slips in). */
  const hold = useCallback(() => {
    stopHold();
    setHeld(true);
    editor?.setEditable(false, false);
  }, [editor, stopHold]);

  /**
   * The lock may have come: save, then swap to the PIN view if the native side
   * now withholds this note. Text that could not be saved (for instance refused
   * with `private_locked`) keeps the editor and the "Not saved"
   * message: never unmounted silently (R14).
   */
  const checkLock = useCallback((): Promise<void> => {
    lockCheck.current ??= (async () => {
      hold();
      await autosave.flush();
      if (!autosave.hasUnsavedChanges) {
        const n = await commands.getNote(note.id).catch(() => null);
        if (n?.locked && !autosave.hasUnsavedChanges) {
          autosave.dispose();
          onLocked(n);
          return; // unmounting
        }
        if (n) applyPrivacy(n.private, n.privateLabel);
      }
      setHeld(false);
    })().finally(() => {
      lockCheck.current = null;
    });
    return lockCheck.current;
  }, [applyPrivacy, autosave, hold, note.id, onLocked]);

  useEffect(() => stopHold, [stopHold]);

  // Flush when focus leaves the window and when the app is quitting. A private
  // note then stays read-only until the lock that may follow arrives, or for
  // LOCK_HOLD_MS, so nothing typed in between is refused by the lock (R14).
  useEffect(() => {
    const onBlur = () => void autosave.flush();
    window.addEventListener("blur", onBlur);
    const unlisten = onSaveAllRequest(() => {
      const privateNow = privateRef.current;
      if (privateNow) hold();
      void autosave
        .flush()
        // Quitting (or exporting, or hiding all) during the strip ends it: the note is marked
        // done once its text is saved, and only then is the round answered.
        // A completion already in flight is awaited, not repeated: the round is answered after it.
        .then(async () => {
          if (completing.current) await completing.current;
          else if (stripRef.current && autosave.currentState !== "error") await completeStrip();
        })
        .then(() => commands.quitReady(autosave.currentState !== "error"))
        .catch(() => undefined)
        .then(() => {
          if (!privateNow || lockCheck.current) return; // a lock check releases the hold itself
          stopHold();
          holdTimer.current = setTimeout(() => {
            holdTimer.current = null;
            setHeld(false);
          }, LOCK_HOLD_MS);
        });
    });
    return () => {
      window.removeEventListener("blur", onBlur);
      void unlisten.then((f) => f());
    };
  }, [autosave, completeStrip, hold, stopHold]);

  // The privacy lock turned on (for every window, or for this kept-open note). When it
  // turns off, text the lock refused to save is saved now.
  useEffect(() => {
    const unlisten = onPrivacyChanged(({ locked: lockedNow }) => {
      if (lockedNow && privateRef.current) void checkLock();
      else if (!lockedNow && autosave.currentState === "error") void autosave.flush();
    });
    return () => void unlisten.then((f) => f());
  }, [autosave, checkLock]);

  // Changes made from another window (colour, lock).
  useEffect(() => {
    const unlisten = onNotesChanged(({ id, kind }) => {
      if (kind !== "content" && (id === null || id === note.id)) {
        commands.getNote(note.id).then(
          (n) => {
            if (n.locked) {
              void checkLock();
              return;
            }
            setColor(n.color);
            // Restyle only: the editor content is never reloaded from here.
            setAppearance(n.appearance);
            setLocked(n.editLocked);
            setPinned(n.window.alwaysOnTop);
            setCollapsedView(n.window.collapsed);
            applyPrivacy(n.private, n.privateLabel);
          },
          () => undefined,
        );
      }
    });
    return () => void unlisten.then((f) => f());
  }, [applyPrivacy, checkLock, note.id]);

  useEffect(() => {
    // false: changing editability is not a content change, so do not emit an update.
    editor?.setEditable(!locked && !held, false);
  }, [editor, locked, held]);

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

  /** The menu just opened the reminder dialog or the Undo strip: its closing must not hand focus to the editor. */
  const reminderFromMenu = useRef(false);

  const closePopover = useCallback(() => {
    setPopover("none");
    // The editor's focus is deferred to the next frame, so it would take focus back from the
    // dialog that the menu pick has just opened (which focuses its date field itself).
    if (reminderFromMenu.current) {
      reminderFromMenu.current = false;
      return;
    }
    editor?.commands.focus();
  }, [editor]);

  const closeReminder = useCallback(() => {
    setReminderOpen(false);
    editor?.commands.focus();
  }, [editor]);

  /** From the menu, focus stays on its toggle (the menu stays open); elsewhere, allowing edits
   * puts the caret at the end of the text. */
  async function setEditLock(value: boolean, focusEditor = true) {
    if (value) await autosave.flush();
    await commands.setEditLocked(note.id, value);
    setLocked(value);
    if (!value && focusEditor) editor?.commands.focus("end");
  }

  // Ctrl+D (Mark as done) and Ctrl+Z (Undo while the strip shows), in the capture phase so the
  // editor never sees them: Tiptap binds no Mod-d, but its undo must not run under the strip.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey || collapsed) return;
      const key = e.key.toLowerCase();
      if (key === "d") {
        // Not under a popover or dialog (menu, colour, text style, reminder, link, private label, unlock).
        if (document.querySelector('.dn-popover, .dn-link-editor, .dn-modal, [role="dialog"], [role="menu"]')) return;
        e.preventDefault();
        e.stopPropagation();
        startStrip();
      } else if (key === "z" && stripRef.current) {
        e.preventDefault();
        e.stopPropagation();
        undoStrip();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [collapsed, startStrip, undoStrip]);

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
        openPopover("link");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [hide, locked, openPopover]);

  /** A refused action (e.g. Duplicate while private notes are locked, D12) says why. */
  async function act(action: () => Promise<unknown>) {
    setRefusal(null);
    try {
      await saveThen(action);
    } catch (e) {
      setRefusal(refusalText(e));
    }
  }

  /** "Make private" needs a PIN: without one, Settings opens at Privacy to set it up first. */
  async function makePrivate() {
    setRefusal(null);
    let status;
    try {
      status = await commands.privacyStatus();
    } catch (e) {
      setRefusal(refusalText(e));
      return;
    }
    if (!status.enabled) {
      await commands.openSettings("privacy").catch((e: unknown) => setRefusal(refusalText(e)));
      return;
    }
    setLabelDialog("make");
  }

  /** Make private (true) or change the label of a private note; a refusal is shown in the dialog. */
  async function confirmLabel(label: string) {
    try {
      await commands.setNotePrivate(note.id, true, label);
    } catch (e) {
      throw new Error(refusalText(e), { cause: e });
    }
    applyPrivacy(true, label);
    setLabelDialog(null);
    editor?.commands.focus();
  }

  /** Keeps the label, in case the note is made private again. */
  async function makeNotPrivate() {
    setRefusal(null);
    try {
      await commands.setNotePrivate(note.id, false, privateLabel);
      applyPrivacy(false, privateLabel);
    } catch (e) {
      // Refused (e.g. while locked): nothing changed, and the reason is shown (R21).
      setRefusal(refusalText(e));
    }
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
    // The rolled-up note shows no strip, so collapsing during it completes the note at once, as a
    // close does: the strip must never run unseen.
    if (next && (stripRef.current || completing.current)) {
      await completeStrip();
      return;
    }
    const run = () => commands.setCollapsed(note.id, next).then(() => setCollapsedView(next));
    if (next) await saveThen(run);
    else await run();
  }

  // DES-38 option B: the quick row, then the list. The toggles keep the menu open.
  const quickActions: QuickAction[] = [
    { id: "new", label: "New", name: "New note", icon: "plus", title: "New note (Ctrl+N)", onSelect: () => void commands.createNote() },
    {
      id: "dup",
      label: "Duplicate",
      name: "Duplicate",
      icon: "duplicate",
      title: "Duplicate this note",
      onSelect: () => void act(() => commands.duplicateNote(note.id)),
    },
    { id: "pin", label: "On top", name: "Always on top", icon: "pin", checkable: true, checked: pinned, onSelect: () => void togglePinned() },
    {
      id: "lock",
      label: "Lock",
      name: "Lock editing",
      icon: "editlock",
      checkable: true,
      checked: locked,
      onSelect: () => void setEditLock(!locked, false),
    },
  ];

  const menuItems: MenuItem[] = [
    {
      id: "reminder",
      label: "Set reminder…",
      icon: "bell",
      onSelect: () => {
        reminderFromMenu.current = true;
        setReminderOpen(true);
      },
    },
    {
      id: "done",
      label: "Mark as done",
      icon: "check",
      onSelect: () => {
        reminderFromMenu.current = true; // the Undo button takes focus; the menu's close must not move it
        startStrip();
      },
    },
    { id: "settings", label: "Note settings…", icon: "settings", onSelect: () => void commands.openNoteSettings(note.id) },
    {
      id: "private",
      label: "Private",
      icon: "lock",
      checked: isPrivate,
      submenu: isPrivate
        ? [
            { id: "private-label", label: "Change private label…", icon: "type", onSelect: () => setLabelDialog("rename") },
            { id: "not-private", label: "Make not private", icon: "unlock", onSelect: () => void makeNotPrivate() },
          ]
        : [{ id: "make-private", label: "Make private", icon: "lock", onSelect: () => void makePrivate() }],
    },
    { id: "manager", label: "Open manager", icon: "note", onSelect: () => void commands.showManager() },
    { id: "archive", label: "Archive", icon: "archive", separatorBefore: true, onSelect: () => void act(() => commands.setArchived(note.id, true)) },
    { id: "trash", label: "Move to trash", icon: "trash", danger: true, onSelect: () => void act(() => commands.trashNote(note.id)) },
  ];

  if (contentError) return <NoteLoadError noteId={note.id} color={color} appearance={appearance} app={app} />;

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
      <div className={`dn-note is-collapsed${look.classes}`} style={look.style}>
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
      // has-readonly-reminder: the header's CSS drops the Read-only word sooner (note.css).
      className={`dn-note${locked ? " is-readonly" : ""}${locked && reminder ? " has-readonly-reminder" : ""}${editing ? " is-editing" : ""}${seeThroughClass(appearance)}${showBar ? " has-bar" : ""}${look.classes}`}
      style={look.style}
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
            <span className="dn-chip-text">Read-only</span>
          </button>
        )}
        {reminder && !narrow && (
          <button
            type="button"
            className={`dn-reminder-chip${reminder.overdue ? " is-overdue" : ""}`}
            aria-label={`Reminder ${reminder.overdue ? "overdue · " : ""}${chipText(reminder.dueAt, new Date())}`}
            title={reminder.overdue ? "Overdue · click to change" : "Reminder · click to change"}
            aria-expanded={reminderOpen}
            data-popover-toggle
            onClick={() => {
              setPopover("none");
              setReminderOpen(!reminderOpen);
            }}
          >
            <Icon name="bell" size={13} />
            <span className="dn-chip-text">{chipText(reminder.dueAt, new Date())}</span>
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
              onClick={() => openPopover(popover === "color" ? "none" : "color")}
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
            onClick={() => openPopover(popover === "menu" ? "none" : "menu")}
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
      {reminderOpen && <ReminderPopover noteId={note.id} initial={reminder} onClose={closeReminder} />}
      {popover === "menu" && (
        <Menu label="Note actions" quick={quickActions} items={menuItems} onClose={closePopover} className="dn-note-menu" />
      )}
      {popover === "link" && editor && <LinkEditor editor={editor} onClose={() => setPopover("none")} />}
      {labelDialog && (
        <PrivateLabelDialog
          mode={labelDialog}
          initialLabel={privateLabel /* kept from an earlier "Make not private" */}
          onConfirm={confirmLabel}
          onCancel={() => {
            setLabelDialog(null);
            editor?.commands.focus();
          }}
        />
      )}

      {stripShown && <DoneStrip onUndo={undoStrip} />}

      <div className="dn-note-body" ref={setBodyEl}>
        <EditorContent editor={editor} />
        <SaveIndicator state={saveState} editing={editing} />
      </div>
      <LinkHint container={bodyEl} />

      {unlocking && (
        <UnlockDialog
          title="Unlock to save"
          text="Private notes were locked before this note was saved. Enter your PIN to save it."
          onUnlocked={() => {
            setUnlocking(false);
            void autosave.flush();
          }}
          onCancel={() => setUnlocking(false)}
        />
      )}
      {refusal && <NoteNotice text={refusal} onDismiss={() => setRefusal(null)} />}
      {saveState === "error" && (
        <SaveError
          reason={saveErrorReason}
          onRetry={() => void autosave.flush()}
          onUnlock={saveRefusedByLock ? () => setUnlocking(true) : undefined}
        />
      )}
      {imageProblem && <ImageMessage key={imageProblem.n} problem={imageProblem.problem} onDismiss={closeImageProblem} />}
      {showBar && editor && (
        <FormatBar
          editor={editor}
          narrow={narrow}
          appearance={shown}
          onLink={() => openPopover("link")}
          noteId={note.id}
          onImageProblem={showImageProblem}
        />
      )}
      {!showBar && saveState !== "error" && !refusal && !imageProblem && (
        <span className="dn-resize-mark" aria-hidden="true">
          <Icon name="resize" size={12} />
        </span>
      )}
    </div>
  );
}
