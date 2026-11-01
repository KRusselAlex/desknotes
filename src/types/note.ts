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

/** What the Settings window shows (Rust `SettingsView`). */
export interface SettingsView {
  launchAtLogin: boolean;
  newNoteColor: string;
  version: string;
  dataDir: string;
}
