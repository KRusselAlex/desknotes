// Mirrors the serde types in crates/desknotes-core/src/model.rs.
// Keep both sides in sync; the shared fixture test guards the content format.

import type { JSONContent } from "@tiptap/react";

export type NoteFilter = "active" | "completed" | "archived" | "trash";

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

export type TextDirection = "auto" | "ltr" | "rtl";

/** Text styling and window opacity of one note (Rust `Appearance`). A missing
 * field means the default; the native side omits fields that are at default. */
export interface Appearance {
  /** A font family installed on this computer; absent = the system font. */
  font?: string;
  /** Pixels, 10 to 32. */
  fontSize?: number;
  /** One of the four text colour presets, lower-case. */
  textColor?: string;
  /** Percent, 100 to 200 in steps of 5. */
  lineSpacing?: number;
  direction?: TextDirection;
  /** Window opacity in percent, 80 to 100 in steps of 5. */
  opacity?: number;
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
  /** When the note was marked done (Unix ms); null while it is not done. */
  completedAt: number | null;
  /** Read-only: the native layer refuses content saves while true. */
  editLocked: boolean;
  /** Marked private: hidden behind the PIN while the privacy lock is on. */
  private: boolean;
  /** Shown instead of the title while locked; "" means "Private note". */
  privateLabel: string;
  /** Withheld by the native layer: `content` is empty and `title` is the label. */
  locked: boolean;
  /** Always present; `{}` when nothing was changed. Revealed even while locked. */
  appearance: Appearance;
  window: NoteWindowState;
}

export interface NoteSummary {
  id: string;
  title: string;
  color: string;
  updatedAt: number;
  archivedAt: number | null;
  deletedAt: number | null;
  completedAt: number | null;
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
  completed: number;
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

export type Layout = "comfortable" | "compact";

/** App-wide look of every note window (Rust `AppAppearance`, Settings → Appearance). */
export interface AppAppearance {
  /** Black on white notes with heavier rules and focus rings. */
  highContrast: boolean;
  layout: Layout;
  /** A font family installed on this computer; null = the system font. */
  defaultFont: string | null;
  /** Default text size in pixels, 10 to 32. */
  defaultSize: number;
}

export const APP_APPEARANCE_DEFAULTS: AppAppearance = {
  highContrast: false,
  layout: "comfortable",
  defaultFont: null,
  defaultSize: 15,
};

/** What the Settings window shows (Rust `SettingsView`). */
export interface SettingsView {
  launchAtLogin: boolean;
  newNoteColor: string;
  /** Smallest size a note window may take, in pixels. */
  minNoteSize: NoteSize;
  appAppearance: AppAppearance;
  version: string;
  /** Readable OS name for the About window, e.g. "Ubuntu 24.04.1 LTS". */
  osName: string;
  dataDir: string;
  /** Last successful export, Unix ms. */
  lastBackupAt: number | null;
}

/** A stored image, as the editor needs it to place the image. */
export interface ImageInfo {
  /** 64 lowercase hex characters (SHA-256 of the stored bytes). */
  id: string;
  width: number;
  height: number;
}

/** What `paste_image` found on the system clipboard (read in Rust; WebKitGTK gives the page none). */
export type PastedImage =
  | { kind: "image"; image: ImageInfo }
  /** No image but text: pasted as plain text, never as HTML. */
  | { kind: "text"; text: string }
  | { kind: "nothing" };

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
  /** What "Forgot your PIN?" uses here: Ubuntu password, recovery code, or neither. */
  recovery: "system" | "code" | "none";
  /** The owner's "If I forget my PIN" choice; null with no PIN or a PIN set before it existed. */
  recoveryMethod: RecoveryMethod | null;
  /** The Ubuntu password can be used here, so "Use my computer password" may be offered. */
  systemAvailable: boolean;
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

/** "If I forget my PIN": the computer (Ubuntu) password or a recovery code (Rust `RecoveryMethod`). */
export type RecoveryMethod = "system" | "code";

/** Result of changing the recovery method (Rust `RecoveryChange`). */
export interface RecoveryChange {
  /** Anything but "ok": nothing changed. */
  check: PinCheck;
  /** The new recovery code when switching to "code", shown once. */
  recoveryCode: string | null;
}

/** The fixed links of the About window. Rust maps each id to its address. */
export type AboutLink = "source" | "issues" | "more_tools" | "notices" | "license";

/** Settings sections another window may open Settings at (Rust `SETTINGS_SECTIONS`).
 * "privacy-new-pin" opens Privacy at "choose a new PIN", after a forgotten-PIN proof. */
export type SettingsSection = "general" | "appearance" | "privacy" | "privacy-new-pin" | "backup" | "about";
