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
//
// Settings → Appearance: ?w=settings&section=appearance. Notes and Note settings take &hc=1
// (high contrast), &compact=1 (compact layout) and &font=Ubuntu (default font) as if set there.
//
// Settings: ?w=settings&section=privacy opens at Privacy (&nopin: lock off, &nosystem: no
// computer-password route, &method=code: recovery code chosen); &section=privacy-new-pin opens
// "choose a new PIN" as after a forgotten-PIN proof. 123456 is refused as too easy.
//
// Note settings: ?w=note-settings opens the Note settings window for &id= (default a2), as the
// native side does with ?note=<id>. Changes apply to the fake note; reload to start again.
//
// Text style (N14): ?w=note&textStyle=1 focuses the note, selects its second line and opens
// the Aa popover (through "More formatting" → "Text style…" when the window is under 260 px).
//
// Forgotten PIN: "Forgot your PIN?" uses the computer password (accepted after a second;
// &systemcancel: refused, as when its dialog is cancelled), the recovery code with
// &method=code or &nosystem (K7QD-M2XP-9WTR-4HNB-C6JF-V8LZ), or explains --reset-pin with
// &norecovery. &reset shows the manager's "The PIN was reset" notice. While private notes are
// locked, backup export and restore, purging and duplicating them are refused as natively.
//
// Reminders: get_reminder, set_reminder, remove_reminder and list_reminders work on an
// in-memory list seeded with an overdue one-off (a1), one later today (a2), a weekday
// repeat tomorrow (a3) and a monthly one on an archived note (r1); &noreminders starts
// empty. Changes emit reminders-changed like the native side. In the console,
// previewFire("a2") makes a2's reminder overdue now, as if it had fired. A note window shows
// its reminder as a chip (B2): ?w=note&reminder=1 gives the note a one-off reminder at 14:00,
// three days from today (the chip shows that day's short name and the time; click it or use
// ⋯ → Set reminder…), &reminder=open also opens the popover (R1). Without &reminder, the
// note keeps the reminder seeded for it above, if any (a2's is two hours from now).
// The manager's Reminders tab (R2) lists them: click the tab; a1 shows as overdue, a2 and a3
// fall under Today and Tomorrow (or Today only, near midnight), r1 under Later. With
// ?w=manager&locked=private, a2 is private and locked, so its row reads "Private note".

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { emit } from "@tauri-apps/api/event";
import fixture from "../../tests/fixtures/rich-doc.json";
import { App } from "../app/App";
import { followSystemTheme } from "../app/theme";
import {
  APP_APPEARANCE_DEFAULTS,
  PRIVATE_FALLBACK_LABEL,
  type AppAppearance,
  type Note,
  type NoteFilter,
  type PinCheck,
  type PrivacyStatus,
  type RecoveryMethod,
} from "../types/note";
import type { ReminderListRow, ReminderView, Repeat } from "../types/reminder";
import "../styles/tokens.css";
import "../styles/global.css";
import "../styles/components.css";
import "../styles/note.css";
import "../styles/manager.css";
import "../styles/settings.css";
import "../styles/privacy.css";
import "../styles/note-settings.css";

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
  appearance: {},
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
  method: (params.get("nopin") === null
    ? params.get("method") === "code" || !systemAvailable
      ? "code"
      : "system"
    : null) as RecoveryMethod | null,
  hasCode:
    params.get("nopin") === null &&
    params.get("norecovery") === null &&
    (!systemAvailable || params.get("method") === "code"),
  lockAfter: 5,
  resetAt: params.get("reset") !== null ? now - 20 * H : null,
};
const PREVIEW_CODE = "K7QD-M2XP-9WTR-4HNB-C6JF-V8LZ";
const tooEasy = (pin: unknown) => pin === "123456" || pin === "000000";
const tooEasyError = { code: "validation", message: "PIN must be 6 digits and not obvious (such as 000000 or 123456)" };
const systemRefused = () => ({ code: "not_allowed", message: "the Ubuntu password cannot be used here; choose a recovery code" });
function privacyStatus(): PrivacyStatus {
  const recovery =
    systemAvailable && privacy.method !== "code" ? "system" : privacy.hasCode ? "code" : "none";
  return {
    enabled: privacy.pinSet,
    locked: privacy.pinSet && privacy.locked,
    lockAfterMinutes: privacy.lockAfter,
    recovery,
    recoveryMethod: privacy.method,
    systemAvailable,
    resetAt: privacy.resetAt,
  };
}
const isWithheld = (n: Note) => privacy.pinSet && privacy.locked && n.private;
const redact = (n: Note): Note => ({
  ...n,
  title: n.privateLabel || PRIVATE_FALLBACK_LABEL,
  content: { type: "doc", content: [{ type: "paragraph" }] },
  locked: true,
});
const notLocked = () => ({ code: "private_locked", message: "private notes are locked" });
const anyWithheld = () => notes.some(isWithheld);
const bare = (code: unknown) => String(code ?? "").replace(/[\s-]/g, "").toUpperCase();
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
const label = which === "note" ? `note-${noteId}` : which === "note-settings" ? "note_settings" : which;
// The native side opens the Note settings window at `?note=<id>`.
if (label === "note_settings" && !params.has("note")) {
  params.set("note", noteId);
  history.replaceState(null, "", `${location.pathname}?${params}`);
}
mockWindows(label);
let shortcut: { available: boolean; binding: string | null; label: string | null } = {
  available: params.get("noshortcut") === null,
  binding: null,
  label: null,
};

// Settings → Appearance, kept in memory like the app keeps it in its database.
// &hc=1 starts with high contrast on, &compact=1 with the compact layout, &font= with a default font.
let appAppearance: AppAppearance = {
  ...APP_APPEARANCE_DEFAULTS,
  highContrast: params.get("hc") === "1",
  layout: params.get("compact") === "1" ? "compact" : "comfortable",
  defaultFont: params.get("font") || null,
};

// Fake reminders, following the native rules loosely (crates/desknotes-core/src/reminders.rs).
interface FakeReminder {
  date: string;
  time: string;
  repeat: Repeat;
  dueAt: number;
}
const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const hm = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const REPEATS: Repeat[] = ["none", "daily", "weekdays", "weekly", "monthly"];
/** The first occurrence of the rule after `after` (the rule's own time for a one-off). */
function firstDue(date: string, time: string, repeat: Repeat, after: number): number {
  const at = new Date(`${date}T${time}`);
  for (let i = 0; repeat !== "none" && i < 400 && at.getTime() <= after; i++) {
    if (repeat === "monthly") at.setMonth(at.getMonth() + 1);
    else at.setDate(at.getDate() + (repeat === "weekly" ? 7 : 1));
    if (repeat === "weekdays") while (at.getDay() === 0 || at.getDay() === 6) at.setDate(at.getDate() + 1);
  }
  return at.getTime();
}
const reminders = new Map<string, FakeReminder>();
if (params.get("noreminders") === null) {
  const seed = (id: string, at: Date, repeat: Repeat) =>
    reminders.set(id, { date: ymd(at), time: hm(at), repeat, dueAt: at.getTime() });
  const today = (h: number, m: number) => {
    const d = new Date(now);
    d.setHours(h, m, 0, 0);
    return d;
  };
  seed("a1", new Date(now - 1.5 * H), "none");
  seed("a2", new Date(now + 2 * H), "none");
  const tomorrow = today(9, 0);
  tomorrow.setDate(tomorrow.getDate() + 1);
  seed("a3", tomorrow, "weekdays");
  const later = today(14, 0);
  later.setDate(later.getDate() + 12);
  seed("r1", later, "monthly");
}
if (which === "note" && params.get("reminder")) {
  const at = new Date(now);
  at.setDate(at.getDate() + 3);
  at.setHours(14, 0, 0, 0);
  reminders.set(noteId, { date: ymd(at), time: hm(at), repeat: "none", dueAt: at.getTime() });
}
const reminderView = (r: FakeReminder): ReminderView => ({ ...r, overdue: r.dueAt <= Date.now() });
const remindersChanged = (noteId: string | null) =>
  setTimeout(() => void emit("reminders-changed", { noteId }), 0);
Object.assign(window, {
  previewFire: (id: string) => {
    const r = reminders.get(id);
    if (!r) return;
    r.dueAt = Date.now() - 1000;
    remindersChanged(id);
  },
});

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
      case "set_note_appearance":
        find(a.id).appearance = structuredClone(a.appearance) as Note["appearance"];
        void emit("notes-changed", { id: a.id, kind: "other" });
        return null;
      case "set_note_size": {
        const n = find(a.id);
        n.window = { ...n.window, width: Number(a.width), height: Number(a.height) };
        return { width: Number(a.width), height: Number(a.height) };
      }
      case "list_fonts":
        return ["DejaVu Sans", "Noto Serif", "Ubuntu", "Ubuntu Mono"];
      case "open_note_settings":
      case "reopen_note":
        return null;
      case "hidden_note_count":
        return 0;
      case "get_settings":
        return { launchAtLogin: false, newNoteColor: "#fff4a3", minNoteSize: { width: 180, height: 120 }, appAppearance: { ...appAppearance }, version: "0.1.0", dataDir: "~/.local/share/io.github.krusselalex.desknotes", lastBackupAt: null };
      case "get_app_appearance":
        return { ...appAppearance };
      case "set_app_appearance": {
        const next = a.appearance as AppAppearance;
        if (!Number.isInteger(next.defaultSize) || next.defaultSize < 10 || next.defaultSize > 32) {
          throw { code: "validation", message: "default text size must be 10–32 px" };
        }
        appAppearance = { ...next, defaultFont: next.defaultFont?.trim() || null };
        void emit("app-appearance-changed", { ...appAppearance });
        return { ...appAppearance };
      }
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
      case "set_always_on_top":
        find(a.id).window.alwaysOnTop = Boolean(a.on);
        return null;
      case "privacy_status":
        return privacyStatus();
      case "setup_pin": {
        if (a.method === "system" && !systemAvailable) throw systemRefused();
        if (privacy.pinSet) throw { code: "not_allowed", message: "a PIN is already set" };
        if (tooEasy(a.pin)) throw tooEasyError;
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
      case "choose_new_pin": {
        if (tooEasy(a.pin)) throw tooEasyError;
        privacy.locked = false;
        announce(false);
        return { recoveryCode: privacyStatus().recovery === "system" ? null : PREVIEW_CODE };
      }
      case "change_pin": {
        if (tooEasy(a.new)) throw tooEasyError;
        return checkPin(String(a.current));
      }
      case "turn_off_lock": {
        const check = checkPin(String(a.pin));
        if (check.kind === "ok") {
          privacy.pinSet = false;
          privacy.method = null;
          privacy.hasCode = false;
          announce(false);
        }
        return check;
      }
      case "set_lock_after":
        privacy.lockAfter = Number(a.minutes);
        return null;
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
      case "forgot_pin_system":
        if (privacyStatus().recovery !== "system") throw { code: "not_allowed", message: "The Ubuntu password cannot be used here. Use the recovery code." };
        // The system's own password dialog would be open for a moment.
        return new Promise<boolean>((resolve) =>
          setTimeout(() => {
            const given = params.get("systemcancel") === null;
            if (given) announce(false);
            resolve(given);
          }, 1000),
        );
      case "recover_with_code": {
        if (!privacy.hasCode) throw { code: "not_allowed", message: "operation not allowed: nothing is set to check" };
        const left = Math.ceil((privacy.waitUntil - Date.now()) / 1000);
        if (left > 0) return { kind: "waiting", waitSecs: left };
        // Same shared waits as a wrong PIN.
        const result = checkPin(bare(a.code) === bare(PREVIEW_CODE) ? PREVIEW_PIN : "");
        if (result.kind === "ok") announce(false);
        return result;
      }
      case "acknowledge_pin_reset":
        privacy.resetAt = null;
        return null;
      case "export_backup":
        if (anyWithheld()) throw notLocked();
        return { path: "~/Documents/desknotes-backup.json", count: notes.length, skipped: 0, exportedAt: Date.now() };
      case "choose_backup":
        if (anyWithheld()) throw notLocked();
        return { fileName: "desknotes-backup.json", backupCount: notes.length, currentCount: notes.length, exportedAt: now - 24 * H };
      case "restore_backup":
        if (anyWithheld()) throw notLocked();
        return { restored: notes.length, safetyCopy: "~/.local/share/io.github.krusselalex.desknotes/backups/pre-restore.db" };
      case "purge_note": {
        const i = notes.findIndex((n) => n.id === a.id);
        if (isWithheld(notes[i]!)) throw notLocked();
        notes.splice(i, 1);
        if (reminders.delete(String(a.id))) remindersChanged(String(a.id));
        return null;
      }
      case "get_reminder": {
        const r = reminders.get(String(a.noteId));
        return r ? reminderView(r) : null;
      }
      case "set_reminder": {
        const [date, time, repeat] = [String(a.date), String(a.time), a.repeat as Repeat];
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time) || !REPEATS.includes(repeat)) {
          throw { code: "validation", message: "invalid data: reminder date must be YYYY-MM-DD" };
        }
        if (find(a.noteId).deletedAt !== null) throw { code: "not_allowed", message: "operation not allowed: restore the note from the trash first" };
        const dueAt = firstDue(date, time, repeat, Date.now());
        if (repeat === "none" && dueAt <= Date.now()) throw { code: "validation", message: "Pick a time in the future." };
        const r = { date, time, repeat, dueAt };
        reminders.set(String(a.noteId), r);
        remindersChanged(String(a.noteId));
        return reminderView(r);
      }
      case "remove_reminder":
        reminders.delete(String(a.noteId));
        remindersChanged(String(a.noteId));
        return null;
      case "list_reminders": {
        const q = String(a.query ?? "").trim().toLowerCase();
        const rows: ReminderListRow[] = [];
        for (const [noteId, r] of reminders) {
          const n = notes.find((x) => x.id === noteId);
          if (!n || n.deletedAt !== null) continue;
          const locked = isWithheld(n);
          const searched = locked ? n.privateLabel || PRIVATE_FALLBACK_LABEL : n.title;
          if (q && !searched.toLowerCase().includes(q)) continue;
          rows.push({
            noteId,
            title: locked ? PRIVATE_FALLBACK_LABEL : n.title,
            color: n.color,
            repeat: r.repeat,
            dueAt: r.dueAt,
            overdue: r.dueAt <= Date.now(),
            locked,
            archived: n.archivedAt !== null,
          });
        }
        return rows.sort((x, y) => x.dueAt - y.dueAt);
      }
      case "duplicate_note":
        if (isWithheld(find(a.id))) throw notLocked();
        return structuredClone(find(a.id));
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
        console.info("preview: open_settings", a.section ?? "", "(the Settings window opens in the app)");
        // Like the native side, an open Settings window is told which section to show.
        if (which === "settings" && a.section) setTimeout(() => void emit("settings-section", a.section), 0);
        return null;
      default:
        console.info("preview: ignored command", cmd, a);
        return null;
    }
  },
  { shouldMockEvents: true },
);

followSystemTheme();

if (which === "note" && params.has("textStyle")) void openTextStyle();
if (which === "note" && params.get("reminder") === "open") void openReminder();

/** Clicks through to the Aa popover once the note is on screen, as a person would. */
async function openTextStyle() {
  const wait = async <T,>(get: () => T | null | undefined): Promise<T> => {
    for (;;) {
      const found = get();
      if (found) return found;
      await new Promise((r) => setTimeout(r, 50));
    }
  };
  const editor = await wait(() => document.querySelector<HTMLElement>(".ProseMirror"));
  editor.focus();
  const line = await wait(() => editor.querySelectorAll("p")[1]?.firstChild);
  getSelection()?.setBaseAndExtent(line, 0, line, 11);
  const aa = await wait(() => document.querySelector<HTMLElement>('[aria-label="Text style"], [aria-label="More formatting"]'));
  aa.click();
  if (aa.getAttribute("aria-label") === "More formatting") {
    const item = await wait(() =>
      Array.from(document.querySelectorAll<HTMLElement>("[data-menu-item]")).find((b) => b.textContent === "Text style…"),
    );
    item.click();
  }
}

/** Clicks the reminder chip once the note is on screen, as a person would. */
async function openReminder() {
  for (;;) {
    const chip = document.querySelector<HTMLElement>(".dn-reminder-chip");
    if (chip) return chip.click();
    await new Promise((r) => setTimeout(r, 50));
  }
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App label={label} />
  </StrictMode>,
);
