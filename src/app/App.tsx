import { ManagerWindow } from "../features/manager/ManagerWindow";
import { NoteSettingsWindow } from "../features/note-settings/NoteSettingsWindow";
import { NoteWindow } from "../features/notes/NoteWindow";
import { SettingsWindow } from "../features/settings/SettingsWindow";
import { noteIdFromUrl } from "../ipc/window";
import { useActivityReporter } from "./activity";

const NOTE_PREFIX = "note-";
/** Underscore on purpose: labels starting with `note-` are note windows. */
const NOTE_SETTINGS = "note_settings";

/** One bundle serves every window; the window label decides what to show. */
export function App({ label }: { label: string | null }) {
  useActivityReporter();
  if (label === "manager") return <ManagerWindow />;
  if (label === "settings") return <SettingsWindow />;
  if (label === NOTE_SETTINGS) {
    const noteId = noteIdFromUrl();
    if (noteId) return <NoteSettingsWindow noteId={noteId} />;
  }
  if (label?.startsWith(NOTE_PREFIX)) return <NoteWindow noteId={label.slice(NOTE_PREFIX.length)} />;
  return (
    <main className="outside-tauri">
      <h1>DeskNotes</h1>
      <p>This interface runs inside the DeskNotes desktop app. Start it with <code>npm run tauri dev</code>.</p>
    </main>
  );
}
