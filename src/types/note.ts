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
}

export interface SaveResult {
  title: string;
  updatedAt: number;
}
