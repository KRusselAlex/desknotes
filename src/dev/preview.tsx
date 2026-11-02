// Development-only preview: runs the real screens in a browser with Tauri's
// official IPC mocks and an in-memory fake database. Not part of the app build
// (vite builds index.html only). Open http://localhost:1420/preview.html?w=manager
// or ?w=note&id=<id>&locked=1 (edit lock). Data resets on reload.
//
// Privacy lock: ?w=note&id=a2&locked=private makes the note private (label from
// &label=, default "Bank"; &label= with nothing shows "Private note") and starts
// locked. The right PIN is 246810. &failures=4 makes the next wrong PIN start the
// 30 s wait (L3); &nopin previews "Make private" without a PIN; &nosystem previews a
// machine where the Ubuntu password cannot be used (the recovery code only). In the console,
// previewLock() locks and previewUnlock() unlocks as the native side would.

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { emit } from "@tauri-apps/api/event";
import fixture from "../../tests/fixtures/rich-doc.json";
import { App } from "../app/App";
import { followSystemTheme } from "../app/theme";
import {
  PRIVATE_FALLBACK_LABEL,
  type Note,
  type NoteFilter,
  type PinCheck,
  type PrivacyStatus,
  type RecoveryMethod,
} from "../types/note";
import "../styles/tokens.css";
import "../styles/global.css";
import "../styles/components.css";
import "../styles/note.css";
import "../styles/manager.css";
import "../styles/settings.css";
import "../styles/privacy.css";

const now = Date.now();
const H = 3_600_000;
const doc = (title: string, ...lines: string[]) => ({
  type: "doc",
  content: [
    { type: "paragraph", content: [{ type: "text", text: title }] },
    ...lines.map((t) => ({ type: "paragraph", content: [{ type: "text", text: t }] })),
  ],
});

const base = {
  createdAt: now,
  archivedAt: null,
  deletedAt: null,
  editLocked: false,
  private: false,
  privateLabel: "",
  locked: false,
};
const win = { x: 0, y: 0, width: 300, height: 280, visible: true, alwaysOnTop: false, collapsed: false };
const notes: Note[] = [
  { ...base, id: "a1", title: "Groceries for Saturday", content: fixture, color: "#fff4a3", updatedAt: now - 0.2 * H, window: win },
  {
    ...base,
    id: "a2",
    title: "Weekend errands",
    color: "#c8f7c5",
    updatedAt: now - 3 * H,
    window: win,
    content: {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "Weekend errands" }] },
        {
          type: "paragraph",
          content: [
            { type: "text", text: "Pick up the bike before 5. Ask Maya about the " },
            { type: "text", text: "Thursday", marks: [{ type: "bold" }] },
            { type: "text", text: " call." },
          ],
        },
        {
          type: "taskList",
          content: [
            { type: "taskItem", attrs: { checked: true }, content: [{ type: "paragraph", content: [{ type: "text", text: "Return library books" }] }] },
            { type: "taskItem", attrs: { checked: false }, content: [{ type: "paragraph", content: [{ type: "text", text: "Buy basil and lemons" }] }] },
            { type: "taskItem", attrs: { checked: false }, content: [{ type: "paragraph", content: [{ type: "text", text: "Water the balcony plants" }] }] },
          ],
        },
      ],
    },
  },
  { ...base, id: "a3", title: "Stand-up notes", content: doc("Stand-up notes", "Release blocked on review"), color: "#cfe8ff", updatedAt: now - 26 * H, window: win },
  { ...base, id: "a4", title: "Ideas for the talk", content: doc("Ideas for the talk"), color: "#ffd8b1", updatedAt: now - 50 * H, window: { ...win, visible: false } },
  { ...base, id: "a5", title: "", content: doc(""), color: "#ffffff", updatedAt: now - 80 * H, window: win },
  { ...base, id: "r1", title: "Trip packing list", content: doc("Trip packing list"), color: "#cfe8ff", updatedAt: now - 400 * H, archivedAt: now - 300 * H, window: { ...win, visible: false } },
  { ...base, id: "t1", title: "Old Wi-Fi password", content: doc("Old Wi-Fi password"), color: "#ffd6e0", updatedAt: now - 500 * H, deletedAt: now - 90 * H, window: { ...win, visible: false } },
];

const text = (n: Note) => JSON.stringify(n.content).replace(/"[a-zA-Z]+":/g, " ").toLowerCase();
const inTab = (n: Note, f: NoteFilter) =>
  f === "trash" ? n.deletedAt !== null : f === "archived" ? n.archivedAt !== null && n.deletedAt === null : n.archivedAt === null && n.deletedAt === null;
const find = (id: unknown) => notes.find((n) => n.id === id)!;

const params = new URLSearchParams(location.search);
const which = params.get("w") ?? "manager";
const noteId = params.get("id") ?? "a2";
const lockParam = params.get("locked");
if (lockParam === "private") {
  find(noteId).private = true;
  find(noteId).privateLabel = params.get("label") ?? "Bank";
} else if (lockParam) find(noteId).editLocked = true;

// Fake privacy lock, following the native rules (crates/desknotes-core/src/db/privacy.rs).
const PREVIEW_PIN = "246810";
const systemAvailable = params.get("nosystem") === null;
const privacy = {
  pinSet: params.get("nopin") === null,
  locked: lockParam === "private",
  failures: Number(params.get("failures") ?? 0),
  waitUntil: 0,
  method: (params.get("nopin") === null ? (systemAvailable ? "system" : "code") : null) as RecoveryMethod | null,
  hasCode: params.get("nopin") === null && !systemAvailable,
};
const PREVIEW_CODE = "K7QD-M2XP-9WTR-4HNB-C6JF-V8LZ";
const systemRefused = () => ({ code: "not_allowed", message: "the Ubuntu password cannot be used here; choose a recovery code" });
function privacyStatus(): PrivacyStatus {
  const recovery =
    systemAvailable && privacy.method !== "code" ? "system" : privacy.hasCode ? "code" : "none";
  return {
    enabled: privacy.pinSet,
    locked: privacy.pinSet && privacy.locked,
    lockAfterMinutes: 5,
    recovery,
    recoveryMethod: privacy.method,
    systemAvailable,
    resetAt: null,
  };
}
const isWithheld = (n: Note) => privacy.pinSet && privacy.locked && n.private;
const redact = (n: Note): Note => ({
  ...n,
  title: n.privateLabel || PRIVATE_FALLBACK_LABEL,
  content: { type: "doc", content: [{ type: "paragraph" }] },
  locked: true,
});
const notLocked = () => ({ code: "not_allowed", message: "private notes are locked" });
function checkPin(pin: string): PinCheck {
  const left = Math.ceil((privacy.waitUntil - Date.now()) / 1000);
  if (left > 0) return { kind: "waiting", waitSecs: left };
  if (pin === PREVIEW_PIN) {
    privacy.failures = 0;
    return { kind: "ok" };
  }
  privacy.failures += 1;
  const waitSecs = privacy.failures < 5 ? 0 : privacy.failures === 5 ? 30 : privacy.failures === 6 ? 60 : 300;
  privacy.waitUntil = Date.now() + waitSecs * 1000;
  return { kind: "wrong", waitSecs };
}
function announce(locked: boolean) {
  privacy.locked = locked;
  setTimeout(() => {
    void emit("privacy-changed", { locked });
    void emit("notes-changed", { id: null, kind: "other" });
  }, 0);
}
Object.assign(window, { previewLock: () => announce(true), previewUnlock: () => announce(false) });
const label = which === "note" ? `note-${noteId}` : which;
mockWindows(label);
let shortcut: { available: boolean; binding: string | null; label: string | null } = {
  available: params.get("noshortcut") === null,
  binding: null,
  label: null,
};

mockIPC(
  (cmd, args) => {
    const a = (args ?? {}) as Record<string, unknown>;
    switch (cmd) {
      case "get_note": {
        const n = find(a.id);
        return structuredClone(isWithheld(n) ? redact(n) : n);
      }
      case "list_notes": {
        const q = String(a.query ?? "").trim().toLowerCase();
        return notes
          .map((n) => (isWithheld(n) ? redact(n) : n))
          .filter((n) => inTab(n, a.filter as NoteFilter) && (!q || (n.locked ? n.title.toLowerCase().includes(q) : text(n).includes(q))))
          .sort((x, y) => y.updatedAt - x.updatedAt)
          .map((n) => ({
            id: n.id, title: n.title, color: n.color, updatedAt: n.updatedAt, archivedAt: n.archivedAt,
            deletedAt: n.deletedAt, visible: n.window.visible, snippet: q && !n.locked ? n.title : null,
            private: n.private, privateLabel: n.privateLabel, locked: n.locked,
          }));
      }
      case "note_counts":
        return { active: notes.filter((n) => inTab(n, "active")).length, archived: notes.filter((n) => inTab(n, "archived")).length, trash: notes.filter((n) => inTab(n, "trash")).length };
      case "startup_errors":
        return params.get("error") ? ["The notes database could not be opened. Notes already on screen are kept open."] : [];
      case "save_note_content": {
        if (params.get("failsave")) throw { code: "io", message: "disk full" };
        const n = find(a.id);
        if (isWithheld(n)) throw notLocked();
        n.content = JSON.parse(String(a.content));
        n.updatedAt = Date.now();
        return { title: n.title, updatedAt: n.updatedAt };
      }
      case "set_note_color":
        find(a.id).color = String(a.color);
        return null;
      case "hidden_note_count":
        return 0;
      case "get_settings":
        return { launchAtLogin: false, newNoteColor: "#fff4a3", minNoteSize: { width: 180, height: 120 }, version: "0.1.0", dataDir: "~/.local/share/io.github.krusselalex.desknotes", lastBackupAt: null };
      case "get_toggle_shortcut":
        return { ...shortcut };
      case "set_toggle_shortcut": {
        if (a.binding === "<Control><Alt>t") throw { code: "shortcut_taken", message: "Ctrl+Alt+T is already used by terminal." };
        const label = String(a.binding).replace("<Control>", "Ctrl+").replace("<Alt>", "Alt+").replace("<Shift>", "Shift+").replace("<Super>", "Super+");
        shortcut = { available: true, binding: String(a.binding), label: label.slice(0, -1) + label.slice(-1).toUpperCase() };
        return { ...shortcut };
      }
      case "remove_toggle_shortcut":
        shortcut = { available: true, binding: null, label: null };
        return { ...shortcut };
      case "set_launch_at_login":
        return Boolean(a.enabled);
      case "set_min_note_size":
        return { width: a.width, height: a.height };
      case "set_edit_locked":
        find(a.id).editLocked = Boolean(a.locked);
        return null;
      case "privacy_status":
        return privacyStatus();
      case "setup_pin": {
        if (a.method === "system" && !systemAvailable) throw systemRefused();
        if (privacy.pinSet) throw { code: "not_allowed", message: "a PIN is already set" };
        privacy.pinSet = true;
        privacy.locked = false;
        privacy.method = a.method as RecoveryMethod;
        privacy.hasCode = a.method === "code";
        announce(false);
        return { recoveryCode: privacy.hasCode ? PREVIEW_CODE : null };
      }
      case "set_recovery_method": {
        if (a.method === "system" && !systemAvailable) throw systemRefused();
        if (!privacy.pinSet) throw { code: "not_allowed", message: "nothing is set to check" };
        const check = checkPin(String(a.pin));
        if (check.kind !== "ok") return { check, recoveryCode: null };
        privacy.method = a.method as RecoveryMethod;
        privacy.hasCode = a.method === "code";
        return { check, recoveryCode: privacy.hasCode ? PREVIEW_CODE : null };
      }
      case "unlock": {
        if (!privacy.pinSet) throw { code: "not_allowed", message: "nothing is set to check" };
        // Like Argon2 in a release build: about a third of a second.
        return new Promise<PinCheck>((resolve) =>
          setTimeout(() => {
            const result = checkPin(String(a.pin));
            if (result.kind === "ok") announce(false);
            resolve(result);
          }, 300),
        );
      }
      case "lock_now":
        if (privacy.pinSet) announce(true);
        return null;
      case "set_note_private": {
        if (a.private && !privacy.pinSet) throw { code: "not_allowed", message: "set up a PIN before making notes private" };
        const n = find(a.id);
        if (isWithheld(n)) throw notLocked();
        const label = String(a.label ?? "").trim();
        if ([...label].length > 40) throw { code: "validation", message: "The label is at most 40 characters." };
        n.private = Boolean(a.private);
        n.privateLabel = label;
        return null;
      }
      case "report_activity":
        return null;
      case "open_settings":
        console.info("preview: open_settings (the Settings window opens in the app)");
        return null;
      default:
        console.info("preview: ignored command", cmd, a);
        return null;
    }
  },
  { shouldMockEvents: true },
);

followSystemTheme();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App label={label} />
  </StrictMode>,
);
