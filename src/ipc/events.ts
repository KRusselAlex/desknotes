import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/** Emitted by Rust after any change. `id` is null when many notes changed.
 * `kind` is "content" for text saves and "other" for everything else. */
export interface NotesChanged {
  id: string | null;
  kind: "content" | "other";
}

export const NOTES_CHANGED = "notes-changed";
/** Rust asks every note window to save now (before quit, export, restore). */
export const SAVE_ALL_NOTES = "save-all-notes";

export function onNotesChanged(handler: (e: NotesChanged) => void): Promise<UnlistenFn> {
  return listen<NotesChanged>(NOTES_CHANGED, (event) => handler(event.payload));
}

/** Save now and answer with `commands.quitReady(saved)`. */
export function onSaveAllRequest(handler: () => void): Promise<UnlistenFn> {
  return listen(SAVE_ALL_NOTES, () => handler());
}

export const NOTE_ACTION = "note-action";
export const QUIT_BLOCKED = "quit-blocked";
export type NoteAction = "hide" | "archive" | "trash";

/** Rust asks this note window to save, then hide, archive or trash itself. */
export function onNoteAction(handler: (action: NoteAction) => void): Promise<UnlistenFn> {
  return listen<NoteAction>(NOTE_ACTION, (event) => handler(event.payload));
}

/** Quitting was cancelled because `count` notes still hold unsaved text. */
export function onQuitBlocked(handler: (count: number) => void): Promise<UnlistenFn> {
  return listen<number>(QUIT_BLOCKED, (event) => handler(event.payload));
}

export const ACTION_FAILED = "action-failed";

/** An action started from the tray failed; the message explains why. */
export function onActionFailed(handler: (message: string) => void): Promise<UnlistenFn> {
  return listen<string>(ACTION_FAILED, (event) => handler(event.payload));
}
