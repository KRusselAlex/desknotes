// Mirrors the serde types in crates/desknotes-core/src/model.rs.
// Keep both sides in sync; the shared fixture test guards the content format.

import type { JSONContent } from "@tiptap/react";

export type NoteFilter = "active" | "archived" | "trash";

export interface NoteWindowState {
  x: number | null;
  y: number | null;
  width: number;
  height: number;
  visible: boolean;
  alwaysOnTop: boolean;
  /** Rolled up to its header strip; height keeps the expanded height. */
  collapsed: boolean;
}

export interface Note {
  id: string;
  title: string;
  content: JSONContent;
  color: string;
  createdAt: number; // Unix ms, UTC
  updatedAt: number;
  archivedAt: number | null;
  deletedAt: number | null;
  /** Read-only: the native layer refuses content saves while true. */
  editLocked: boolean;
  /** Marked private: hidden behind the PIN while the privacy lock is on. */
  private: boolean;
  /** Shown instead of the title while locked; "" means "Private note". */
  privateLabel: string;
  /** Withheld by the native layer: `content` is empty and `title` is the label. */
  locked: boolean;
  window: NoteWindowState;
}

export interface NoteSummary {
  id: string;
  title: string;
  color: string;
  updatedAt: number;
  archivedAt: number | null;
  deletedAt: number | null;
  visible: boolean;
  /** Text around the first match, only when searching. */
  snippet: string | null;
  private: boolean;
  privateLabel: string;
  /** Withheld: `title` is the label and there is never a snippet. */
  locked: boolean;
}

export interface NoteCounts {
  active: number;
  archived: number;
  trash: number;
}

export interface SaveResult {
  title: string;
  updatedAt: number;
}

/** A note size in whole pixels (Rust `NoteSize`). */
export interface NoteSize {
  width: number;
  height: number;
}

/** The "Show / hide all notes" shortcut as GNOME has it (Rust `ToggleShortcut`). */
export interface ToggleShortcut {
  /** False on desktops without GNOME custom shortcuts. */
  available: boolean;
  /** GNOME accelerator text, e.g. `<Control><Alt>n`; null when not set up. */
  binding: string | null;
  /** Readable form, e.g. "Ctrl+Alt+N". */
  label: string | null;
}

/** What the Settings window shows (Rust `SettingsView`). */
export interface SettingsView {
  launchAtLogin: boolean;
  newNoteColor: string;
  /** Smallest size a note window may take, in pixels. */
  minNoteSize: NoteSize;
  version: string;
  dataDir: string;
  /** Last successful export, Unix ms. */
  lastBackupAt: number | null;
}

export interface ExportResult {
  path: string;
  count: number;
  skipped: number;
  exportedAt: number;
}

export interface RestorePreview {
  fileName: string;
  backupCount: number;
  currentCount: number;
  exportedAt: number;
}

export interface RestoreResult {
  restored: number;
  safetyCopy: string;
}

/** Shown in a locked note's header when its label is empty (Rust `PRIVATE_FALLBACK_LABEL`). */
export const PRIVATE_FALLBACK_LABEL = "Private note";
/** Longest private label, in characters (Rust `PRIVATE_LABEL_MAX_CHARS`). */
export const PRIVATE_LABEL_MAX_CHARS = 40;

/** The privacy lock as every window may see it (Rust `PrivacyStatus`). */
export interface PrivacyStatus {
  /** A PIN is set. */
  enabled: boolean;
  /** Private notes are locked now. */
  locked: boolean;
  lockAfterMinutes: number;
  /** How a forgotten PIN is replaced: Ubuntu password, recovery code, or neither. */
  recovery: "system" | "code" | "none";
  /** When `desknotes --reset-pin` removed the PIN (Unix ms), until acknowledged. */
  resetAt: number | null;
}

/** Result of checking a PIN or recovery code (Rust `PinCheck`). `waitSecs` 0 = no wait. */
export type PinCheck =
  | { kind: "ok" }
  | { kind: "wrong"; waitSecs: number }
  | { kind: "waiting"; waitSecs: number };

/** Result of choosing a PIN: a recovery code only where it is the way back. */
export interface SetupResult {
  recoveryCode: string | null;
}
