import { render, screen } from "@testing-library/react";

vi.mock("../features/manager/ManagerWindow", () => ({ ManagerWindow: () => <p>manager</p> }));
vi.mock("../features/notes/NoteWindow", () => ({
  NoteWindow: ({ noteId }: { noteId: string }) => <p>note {noteId}</p>,
}));

import { App } from "./App";

describe("App window routing", () => {
  it("routes by window label", () => {
    const { rerender } = render(<App label="manager" />);
    expect(screen.getByText("manager")).toBeInTheDocument();
    rerender(<App label="note-1234-abcd" />);
    expect(screen.getByText("note 1234-abcd")).toBeInTheDocument();
    rerender(<App label={null} />);
    expect(screen.getByRole("heading", { name: "DeskNotes" })).toBeInTheDocument();
  });
});
