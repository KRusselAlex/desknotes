import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { AppAppearance } from "../types/note";
import type { RemindersChanged } from "../types/reminder";

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
export type NoteAction = "hide" | "archive" | "trash" | "complete" | "reopen";

/** Rust asks this note window to save, then hide, archive, trash, complete or reopen itself. */
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

export const PRIVACY_CHANGED = "privacy-changed";

/** The privacy lock turned on or off. Sent to every window, or to one note
 * window when that note, kept open at the last lock, has now locked. */
export interface PrivacyChanged {
  locked: boolean;
}

export function onPrivacyChanged(handler: (e: PrivacyChanged) => void): Promise<UnlistenFn> {
  return listen<PrivacyChanged>(PRIVACY_CHANGED, (event) => handler(event.payload));
}

export const SETTINGS_SECTION = "settings-section";

/** Another window asked the open Settings window to show a section. */
export function onSettingsSection(handler: (section: string) => void): Promise<UnlistenFn> {
  return listen<string>(SETTINGS_SECTION, (event) => handler(event.payload));
}

export const NOTE_RESIZED = "note-resized";

/** A note window was resized (sent to the Note settings window only). */
export interface NoteResized {
  id: string;
  width: number;
  height: number;
}

export function onNoteResized(handler: (e: NoteResized) => void): Promise<UnlistenFn> {
  return listen<NoteResized>(NOTE_RESIZED, (event) => handler(event.payload));
}

export const NOTE_SETTINGS_NOTE = "note-settings-note";

/** The Note settings window was pointed at another note (its id; sent to that window only). */
export function onNoteSettingsNote(handler: (id: string) => void): Promise<UnlistenFn> {
  return listen<string>(NOTE_SETTINGS_NOTE, (event) => handler(event.payload));
}

export const APP_APPEARANCE_CHANGED = "app-appearance-changed";

/** The app-wide note appearance was saved in Settings (sent to every window). */
export function onAppAppearanceChanged(handler: (a: AppAppearance) => void): Promise<UnlistenFn> {
  return listen<AppAppearance>(APP_APPEARANCE_CHANGED, (event) => handler(event.payload));
}

export const REMINDERS_CHANGED = "reminders-changed";

/** A reminder was set, removed, fired, snoozed or dismissed (sent to every window). */
export function onRemindersChanged(handler: (e: RemindersChanged) => void): Promise<UnlistenFn> {
  return listen<RemindersChanged>(REMINDERS_CHANGED, (event) => handler(event.payload));
}
