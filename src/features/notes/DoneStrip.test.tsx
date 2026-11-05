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
});
