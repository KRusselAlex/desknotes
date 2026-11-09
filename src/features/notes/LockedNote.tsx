import { useCallback, useEffect, useState } from "react";
import { Icon } from "../../components/Icon";
import { commands } from "../../ipc/commands";
import { onNoteAction, onNotesChanged, onPrivacyChanged, onSaveAllRequest } from "../../ipc/events";
import { onCloseRequested } from "../../ipc/window";
import { PRIVATE_FALLBACK_LABEL, type AppAppearance, type Note } from "../../types/note";
import { seeThroughClass } from "../appearance/appearance";
import { ForgotPin } from "../privacy/ForgotPin";
import { PinPad } from "../privacy/PinPad";
import { noteLook, useSeeThrough } from "./noteLook";

/**
 * A private note while the privacy lock is on (design "PIN inside a note"): its
 * colour, its label (never its title) and the window controls, with the PIN pad
 * as the body. `onNote` receives the note again after any change; once it is
 * unlocked the editor mounts with the real text.
 */
export function LockedNote({ note, onNote, app }: { note: Note; onNote: (n: Note) => void; app: AppAppearance }) {
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

  // Rolling up or out shows only the label or the PIN pad: nothing to save, no text revealed.
  const collapse = () => void commands.setCollapsed(note.id, true).then(refresh, () => undefined);
  return (
    <div className={`dn-note is-private-locked${seeThroughClass(note.appearance)}${look.classes}`} style={look.style}>
      <header className="dn-note-header" data-tauri-drag-region>
        <span className="dn-grip" data-tauri-drag-region>
          <Icon name="grip" size={14} />
        </span>
        <button
          type="button"
          className="dn-tool dn-locked-collapse"
          aria-label="Collapse note"
          aria-expanded="true"
          title="Collapse to header"
          onClick={collapse}
        >
          <Icon name="chevdown" />
        </button>
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
