import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/** Emitted by Rust after any change. `id` is null when many notes changed. */
export interface NotesChanged {
  id: string | null;
}

export const NOTES_CHANGED = "notes-changed";

export function onNotesChanged(handler: (e: NotesChanged) => void): Promise<UnlistenFn> {
  return listen<NotesChanged>(NOTES_CHANGED, (event) => handler(event.payload));
}
