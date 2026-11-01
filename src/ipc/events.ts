import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/** Emitted by Rust after any change. `id` is null when many notes changed.
 * `kind` is "content" for text saves and "other" for everything else. */
export interface NotesChanged {
  id: string | null;
  kind: "content" | "other";
}

export const NOTES_CHANGED = "notes-changed";
export const APP_WILL_QUIT = "app-will-quit";

export function onNotesChanged(handler: (e: NotesChanged) => void): Promise<UnlistenFn> {
  return listen<NotesChanged>(NOTES_CHANGED, (event) => handler(event.payload));
}

/** Sent shortly before the app exits; note windows flush unsaved text. */
export function onAppWillQuit(handler: () => void): Promise<UnlistenFn> {
  return listen(APP_WILL_QUIT, () => handler());
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
