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
