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
