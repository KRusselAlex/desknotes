// The only module allowed to call native commands (enforced by ESLint).
// Every function maps 1:1 to a #[tauri::command] in src-tauri/src/commands.

import { invoke } from "@tauri-apps/api/core";
import type { Note, NoteFilter, NoteSummary, SaveResult } from "../types/note";

/** Error shape produced by the Rust side (`IpcError`). */
export class CommandError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "CommandError";
  }
}

async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(command, args);
  } catch (raw) {
    if (raw && typeof raw === "object" && "code" in raw && "message" in raw) {
      throw new CommandError(String(raw.code), String(raw.message));
    }
    throw new CommandError("unknown", String(raw));
  }
}

export const commands = {
  listNotes: (filter: NoteFilter, query: string) =>
    call<NoteSummary[]>("list_notes", { filter, query }),
  getNote: (id: string) => call<Note>("get_note", { id }),
  createNote: () => call<Note>("create_note"),
  /** `content` is the serialized editor document; Rust validates it. */
  saveNoteContent: (id: string, content: string) =>
    call<SaveResult>("save_note_content", { id, content }),
  setNoteColor: (id: string, color: string) => call<void>("set_note_color", { id, color }),
  duplicateNote: (id: string) => call<Note>("duplicate_note", { id }),
  setArchived: (id: string, archived: boolean) => call<void>("set_archived", { id, archived }),
  trashNote: (id: string) => call<void>("trash_note", { id }),
  restoreNote: (id: string) => call<void>("restore_note", { id }),
  purgeNote: (id: string) => call<void>("purge_note", { id }),
  showNote: (id: string) => call<void>("show_note", { id }),
  hideNote: (id: string) => call<void>("hide_note", { id }),
  setEditLocked: (id: string, locked: boolean) => call<void>("set_edit_locked", { id, locked }),
  showManager: () => call<void>("show_manager"),
  startupErrors: () => call<string[]>("startup_errors"),
  quitApp: () => call<void>("quit_app"),
};

export type Commands = typeof commands;
