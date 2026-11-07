import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DoneStrip } from "./DoneStrip";

describe("DoneStrip", () => {
  it("says the note is marked done, as a status, and offers Undo", () => {
    render(<DoneStrip onUndo={() => undefined} />);
    expect(screen.getByRole("status")).toHaveTextContent("Marked done");
    expect(screen.getByRole("button", { name: "Undo" })).toBeInTheDocument();
  });

  it("describes Undo by the status text, so focusing it announces both", () => {
    render(<DoneStrip onUndo={() => undefined} />);
    expect(screen.getByRole("button", { name: "Undo" })).toHaveAccessibleDescription("Marked done");
  });

  it("puts focus on Undo when it appears", () => {
    render(<DoneStrip onUndo={() => undefined} />);
    expect(screen.getByRole("button", { name: "Undo" })).toHaveFocus();
  });

  it("calls onUndo when Undo is pressed", async () => {
    const onUndo = vi.fn();
    render(<DoneStrip onUndo={onUndo} />);
    await userEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(onUndo).toHaveBeenCalledOnce();
  });

  it("shows a custom text, and describes Undo by it", () => {
    render(<DoneStrip text="Checklist reset for this reminder" onUndo={() => undefined} />);
    expect(screen.getByRole("status")).toHaveTextContent("Checklist reset for this reminder");
    expect(screen.getByRole("button", { name: "Undo" })).toHaveAccessibleDescription("Checklist reset for this reminder");
  });

  it("says Marked done when no text is given", () => {
    render(<DoneStrip onUndo={() => undefined} />);
    expect(screen.getByRole("status").textContent).toBe("Marked done");
  });

  it("leaves focus where it is when asked not to take it", () => {
    render(<DoneStrip text="Checklist reset for this reminder" takeFocus={false} onUndo={() => undefined} />);
    expect(screen.getByRole("button", { name: "Undo" })).not.toHaveFocus();
  });
});
