import { render, screen } from "@testing-library/react";

vi.mock("../features/manager/ManagerWindow", () => ({ ManagerWindow: () => <p>manager</p> }));
vi.mock("../features/settings/SettingsWindow", () => ({ SettingsWindow: () => <p>settings</p> }));
vi.mock("../features/note-settings/NoteSettingsWindow", () => ({
  NoteSettingsWindow: ({ noteId }: { noteId: string }) => <p>note settings {noteId}</p>,
}));
vi.mock("../ipc/window", () => ({
  noteIdFromUrl: () => "5678-efgh",
}));
vi.mock("../features/notes/NoteWindow", () => ({
  NoteWindow: ({ noteId }: { noteId: string }) => <p>note {noteId}</p>,
}));

import { App, isNoteWindow } from "./App";

describe("App window routing", () => {
  it("routes by window label", () => {
    const { rerender } = render(<App label="manager" />);
    expect(screen.getByText("manager")).toBeInTheDocument();
    rerender(<App label="settings" />);
    expect(screen.getByText("settings")).toBeInTheDocument();
    rerender(<App label="note-1234-abcd" />);
    expect(screen.getByText("note 1234-abcd")).toBeInTheDocument();
    rerender(<App label="note_settings" />);
    expect(screen.getByText("note settings 5678-efgh")).toBeInTheDocument();
    rerender(<App label={null} />);
    expect(screen.getByRole("heading", { name: "DeskNotes" })).toBeInTheDocument();
  });
});

describe("isNoteWindow", () => {
  it("is true for note windows only, not Note settings", () => {
    expect(isNoteWindow("note-0b9d6f6e-3f0a-4b8e-9a51-2a4c1d7e8f90")).toBe(true);
    for (const label of ["note_settings", "manager", "settings", "", null]) expect(isNoteWindow(label), String(label)).toBe(false);
  });
});
