// The only module allowed to call native commands (enforced by ESLint).
// Every function maps 1:1 to a #[tauri::command] in src-tauri/src/commands.

import { invoke } from "@tauri-apps/api/core";
import type {
  ExportResult,
  Note,
  NoteCounts,
  NoteFilter,
  NoteSummary,
  RestorePreview,
  RestoreResult,
  SaveResult,
  SettingsView,
} from "../types/note";

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
  noteCounts: () => call<NoteCounts>("note_counts"),
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
  setAlwaysOnTop: (id: string, on: boolean) => call<void>("set_always_on_top", { id, on }),
  setCollapsed: (id: string, collapsed: boolean) => call<void>("set_collapsed", { id, collapsed }),
  showManager: () => call<void>("show_manager"),
  /** Saves every note, hides them all and remembers which. Returns how many. */
  hideAllNotes: () => call<number>("hide_all_notes"),
  /** Shows the notes hidden by hideAllNotes again. Returns how many. */
  showHiddenNotes: () => call<number>("show_hidden_notes"),
  hiddenNoteCount: () => call<number>("hidden_note_count"),
  startupErrors: () => call<string[]>("startup_errors"),
  quitApp: () => call<void>("quit_app"),
  openSettings: () => call<void>("open_settings"),
  getSettings: () => call<SettingsView>("get_settings"),
  /** Returns the launcher state actually in effect afterwards. */
  setLaunchAtLogin: (enabled: boolean) => call<boolean>("set_launch_at_login", { enabled }),
  setNewNoteColor: (color: string) => call<void>("set_new_note_color", { color }),
  openDataFolder: () => call<void>("open_data_folder"),
  /** Opens a save dialog; null when cancelled. */
  exportBackup: () => call<ExportResult | null>("export_backup"),
  /** Opens a file dialog and validates the file; null when cancelled. Nothing changes yet. */
  chooseBackup: () => call<RestorePreview | null>("choose_backup"),
  cancelRestore: () => call<void>("cancel_restore"),
  /** Replaces every note with the chosen backup (after a safety copy). */
  restoreBackup: () => call<RestoreResult>("restore_backup"),
  /** Answer to save-all-notes: whether this window's text is saved. */
  quitReady: (saved: boolean) => call<void>("quit_ready", { saved }),
};

export type Commands = typeof commands;
