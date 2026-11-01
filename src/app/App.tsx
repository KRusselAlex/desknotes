import { ManagerWindow } from "../features/manager/ManagerWindow";
import { NoteWindow } from "../features/notes/NoteWindow";

const NOTE_PREFIX = "note-";

/** One bundle serves every window; the window label decides what to show. */
export function App({ label }: { label: string | null }) {
  if (label === "manager") return <ManagerWindow />;
  if (label?.startsWith(NOTE_PREFIX)) return <NoteWindow noteId={label.slice(NOTE_PREFIX.length)} />;
  return (
    <main className="outside-tauri">
      <h1>DeskNotes</h1>
      <p>This interface runs inside the DeskNotes desktop app. Start it with <code>npm run tauri dev</code>.</p>
    </main>
  );
}
