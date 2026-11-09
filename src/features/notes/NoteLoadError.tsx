import { Icon } from "../../components/Icon";
import { commands } from "../../ipc/commands";
import type { AppAppearance, Appearance } from "../../types/note";
import { seeThroughClass } from "../appearance/appearance";
import { noteLook, useSeeThrough } from "./noteLook";

/** Design N7: keeps a note look, header still drags and hides. */
export function NoteLoadError({
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
