// Development-only preview: runs the real screens in a browser with Tauri's
// official IPC mocks and an in-memory fake database. Not part of the app build
// (vite builds index.html only). Open http://localhost:1420/preview.html?w=manager
// or ?w=note&id=<id>&locked=1. Data resets on reload.

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import fixture from "../../tests/fixtures/rich-doc.json";
import { App } from "../app/App";
import { followSystemTheme } from "../app/theme";
import type { Note, NoteFilter } from "../types/note";
import "../styles/tokens.css";
import "../styles/global.css";
import "../styles/components.css";
import "../styles/note.css";
import "../styles/manager.css";
import "../styles/settings.css";

const now = Date.now();
const H = 3_600_000;
const doc = (title: string, ...lines: string[]) => ({
  type: "doc",
  content: [
    { type: "paragraph", content: [{ type: "text", text: title }] },
    ...lines.map((t) => ({ type: "paragraph", content: [{ type: "text", text: t }] })),
  ],
});

const base = { createdAt: now, archivedAt: null, deletedAt: null, editLocked: false };
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
if (params.get("locked")) find(noteId).editLocked = true;
const label = which === "note" ? `note-${noteId}` : which;
mockWindows(label);

mockIPC(
  (cmd, args) => {
    const a = (args ?? {}) as Record<string, unknown>;
    switch (cmd) {
      case "get_note":
        return structuredClone(find(a.id));
      case "list_notes": {
        const q = String(a.query ?? "").trim().toLowerCase();
        return notes
          .filter((n) => inTab(n, a.filter as NoteFilter) && (!q || text(n).includes(q)))
          .sort((x, y) => y.updatedAt - x.updatedAt)
          .map((n) => ({
            id: n.id, title: n.title, color: n.color, updatedAt: n.updatedAt, archivedAt: n.archivedAt,
            deletedAt: n.deletedAt, visible: n.window.visible, snippet: q ? n.title : null,
          }));
      }
      case "note_counts":
        return { active: notes.filter((n) => inTab(n, "active")).length, archived: notes.filter((n) => inTab(n, "archived")).length, trash: notes.filter((n) => inTab(n, "trash")).length };
      case "startup_errors":
        return params.get("error") ? ["The notes database could not be opened. Notes already on screen are kept open."] : [];
      case "save_note_content": {
        if (params.get("failsave")) throw { code: "io", message: "disk full" };
        const n = find(a.id);
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
      case "set_launch_at_login":
        return Boolean(a.enabled);
      case "set_min_note_size":
        return { width: a.width, height: a.height };
      case "set_edit_locked":
        find(a.id).editLocked = Boolean(a.locked);
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
