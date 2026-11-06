// The only module allowed to call native commands (enforced by ESLint).
// Every function maps 1:1 to a #[tauri::command] in src-tauri/src/commands.

import { invoke } from "@tauri-apps/api/core";
import type {
  AppAppearance,
  Appearance,
  ExportResult,
  ImageInfo,
  Note,
  NoteCounts,
  NoteFilter,
  NoteSize,
  NoteSummary,
  PastedImage,
  PinCheck,
  PrivacyStatus,
  RecoveryChange,
  RecoveryMethod,
  RestorePreview,
  RestoreResult,
  SaveResult,
  SettingsView,
  AboutLink,
  SettingsSection,
  SetupResult,
  ToggleShortcut,
} from "../types/note";
import type { ReminderListRow, ReminderView, Repeat } from "../types/reminder";

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

function toCommandError(raw: unknown): CommandError {
  if (raw && typeof raw === "object" && "code" in raw && "message" in raw) {
    return new CommandError(String(raw.code), String(raw.message));
  }
  return new CommandError("unknown", String(raw));
}

async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(command, args);
  } catch (raw) {
    throw toCommandError(raw);
  }
}

/** Like `call`, for a command that takes raw bytes as its body (no JSON, no base64). */
async function callRaw<T>(
  command: string,
  bytes: Uint8Array,
  headers: Record<string, string>,
): Promise<T> {
  try {
    return await invoke<T>(command, bytes, { headers });
  } catch (raw) {
    throw toCommandError(raw);
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
  /** Replaces the note's text styling and opacity. Crossing 100 % reopens an open note window. */
  setNoteAppearance: (id: string, appearance: Appearance) =>
    call<void>("set_note_appearance", { id, appearance }),
  /** Resizes the note window; returns the size that was applied. */
  setNoteSize: (id: string, width: number, height: number) =>
    call<NoteSize>("set_note_size", { id, width, height }),
  /** Font families installed on this computer, A to Z. */
  listFonts: () => call<string[]>("list_fonts"),
  /** Opens (or switches) the Note settings window for this note. */
  openNoteSettings: (id: string) => call<void>("open_note_settings", { id }),
  /** Closes and reopens the note window. Call only after this note saved itself. */
  reopenNote: (id: string) => call<void>("reopen_note", { id }),
  duplicateNote: (id: string) => call<Note>("duplicate_note", { id }),
  setArchived: (id: string, archived: boolean) => call<void>("set_archived", { id, archived }),
  /** Mark a note done (closes its window) or reopen it (opens its window). */
  setNoteCompleted: (id: string, done: boolean) => call<void>("set_note_completed", { id, done }),
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
  /** Opens (or focuses) Settings, at `section` when given. */
  openSettings: (section?: SettingsSection) => call<void>("open_settings", { section: section ?? null }),
  getSettings: () => call<SettingsView>("get_settings"),
  /** Returns the launcher state actually in effect afterwards. */
  setLaunchAtLogin: (enabled: boolean) => call<boolean>("set_launch_at_login", { enabled }),
  setNewNoteColor: (color: string) => call<void>("set_new_note_color", { color }),
  /** Applies to open notes too. Returns the size that was saved. */
  setMinNoteSize: (width: number, height: number) =>
    call<NoteSize>("set_min_note_size", { width, height }),
  getAppAppearance: () => call<AppAppearance>("get_app_appearance"),
  /** Saves and tells every window. Returns the normalised value; a refused value throws. */
  setAppAppearance: (appearance: AppAppearance) =>
    call<AppAppearance>("set_app_appearance", { appearance }),
  getToggleShortcut: () => call<ToggleShortcut>("get_toggle_shortcut"),
  /** Adds or changes DeskNotes' GNOME shortcut. Call only after the person confirmed. */
  setToggleShortcut: (binding: string) => call<ToggleShortcut>("set_toggle_shortcut", { binding }),
  removeToggleShortcut: () => call<ToggleShortcut>("remove_toggle_shortcut"),
  openDataFolder: () => call<void>("open_data_folder"),
  /** Opens one of the About window's fixed links in the system browser. */
  openExternalLink: (id: AboutLink) => call<void>("open_external_link", { id }),
  /** Opens a save dialog; null when cancelled. */
  exportBackup: () => call<ExportResult | null>("export_backup"),
  /** Opens a file dialog and validates the file; null when cancelled. Nothing changes yet. */
  chooseBackup: () => call<RestorePreview | null>("choose_backup"),
  cancelRestore: () => call<void>("cancel_restore"),
  /** Replaces every note with the chosen backup (after a safety copy). */
  restoreBackup: () => call<RestoreResult>("restore_backup"),
  /** Checks, shrinks and stores an image for a note; the bytes travel as the raw IPC body. */
  addImage: (noteId: string, bytes: Uint8Array) =>
    callRaw<ImageInfo>("add_image", bytes, { "note-id": noteId }),
  /** Opens the file picker in Rust and adds the chosen image; null when cancelled. */
  pickImage: (noteId: string) => call<ImageInfo | null>("pick_image", { noteId }),
  /** Reads the system clipboard in Rust: stores its image for the note, or gives back its text. */
  pasteImage: (noteId: string) => call<PastedImage>("paste_image", { noteId }),
  /** Answer to save-all-notes: whether this window's text is saved. */
  quitReady: (saved: boolean) => call<void>("quit_ready", { saved }),

  // Privacy lock. PINs are sent once to be checked and never stored here.
  privacyStatus: () => call<PrivacyStatus>("privacy_status"),
  /** Unlocks every private note when the PIN is right. */
  unlock: (pin: string) => call<PinCheck>("unlock", { pin }),
  /** Saves every open note, then locks private notes. */
  lockNow: () => call<void>("lock_now"),
  /** Settings only. "system" is refused where the Ubuntu password cannot be used. */
  setupPin: (pin: string, method: RecoveryMethod) => call<SetupResult>("setup_pin", { pin, method }),
  /** Settings only. */
  changePin: (current: string, next: string) => call<PinCheck>("change_pin", { current, new: next }),
  /** Settings only. Private flags and labels are kept. */
  turnOffLock: (pin: string) => call<PinCheck>("turn_off_lock", { pin }),
  /** Settings only. Null when the PIN was not accepted. */
  /** Settings only. Switching to "code" returns the new recovery code, shown once. */
  setRecoveryMethod: (pin: string, method: RecoveryMethod) =>
    call<RecoveryChange>("set_recovery_method", { pin, method }),
  /** Settings only: 1, 5, 10 or 15. */
  setLockAfter: (minutes: number) => call<void>("set_lock_after", { minutes }),
  /** Making a note private needs a PIN; `label` replaces the stored one ("" or null clears it). */
  setNotePrivate: (id: string, isPrivate: boolean, label: string | null) =>
    call<void>("set_note_private", { id, private: isPrivate, label }),
  /** Input seen in this window, for the inactivity lock. */
  reportActivity: () => call<void>("report_activity"),
  acknowledgePinReset: () => call<void>("acknowledge_pin_reset"),
  /** Asks for the Ubuntu password; true when it was given and the lock is off. */
  forgotPinSystem: () => call<boolean>("forgot_pin_system"),
  recoverWithCode: (code: string) => call<PinCheck>("recover_with_code", { code }),
  /** Settings only, after forgotPinSystem or recoverWithCode succeeded. */
  chooseNewPin: (pin: string) => call<SetupResult>("choose_new_pin", { pin }),

  // Reminders. Rust validates the date, time and repeat and owns every time rule.
  /** The note's reminder, or null when it has none. */
  getReminder: (noteId: string) => call<ReminderView | null>("get_reminder", { noteId }),
  /** Replaces any earlier reminder. `date` is YYYY-MM-DD, `time` HH:MM (24 h). A one-off
   * in the past is refused with "Pick a time in the future." (CommandError message). */
  setReminder: (noteId: string, date: string, time: string, repeat: Repeat) =>
    call<ReminderView>("set_reminder", { noteId, date, time, repeat }),
  removeReminder: (noteId: string) => call<void>("remove_reminder", { noteId }),
  /** Reminders on notes not in the trash, earliest first, filtered by title. */
  listReminders: (query: string) => call<ReminderListRow[]>("list_reminders", { query }),
};

export type Commands = typeof commands;
