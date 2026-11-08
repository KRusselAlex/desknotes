import { useId, useState } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Segmented } from "../../components/Segmented";
import { Dialog } from "./Dialog";

function Steps() {
  const titleId = useId();
  const [step, setStep] = useState(1);
  return (
    <Dialog titleId={titleId}>
      <div id={titleId}>Step {step}</div>
      {step === 1 ? (
        <button type="button" onClick={() => setStep(2)}>
          Next
        </button>
      ) : (
        <span>No buttons here</span>
      )}
    </Dialog>
  );
}

describe("Dialog", () => {
  it("keeps focus when the focused control goes away (DES-30)", async () => {
    render(<Steps />);
    await userEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(await screen.findByText("Step 2")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("dialog")).toHaveFocus());
  });

  it("Tab skips the options a segmented control keeps out of the Tab order", async () => {
    const titleId = "t";
    render(
      <Dialog titleId={titleId}>
        <div id={titleId}>Choose</div>
        <Segmented
          label="Way back"
          options={[
            { value: "system", label: "Computer password" },
            { value: "code", label: "Recovery code" },
          ]}
          value="code"
          onChange={vi.fn()}
        />
        <button type="button">Cancel</button>
      </Dialog>,
    );
    await userEvent.tab();
    expect(screen.getByRole("radio", { name: "Recovery code" })).toHaveFocus();
    await userEvent.tab();
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
    await userEvent.tab();
    expect(screen.getByRole("radio", { name: "Recovery code" })).toHaveFocus();
  });

  it("Tab from an option the arrows moved to goes on to the next control, not the first", async () => {
    const titleId = "t";
    render(
      <Dialog titleId={titleId}>
        <div id={titleId}>Choose</div>
        <button type="button">Before</button>
        <Segmented
          label="Way back"
          options={[
            { value: "system", label: "Computer password" },
            { value: "code", label: "Recovery code" },
          ]}
          value="system"
          onChange={vi.fn()}
        />
        <button type="button">Cancel</button>
      </Dialog>,
    );
    await userEvent.tab();
    await userEvent.tab();
    expect(screen.getByRole("radio", { name: "Computer password" })).toHaveFocus();
    await userEvent.keyboard("{ArrowRight}");
    expect(screen.getByRole("radio", { name: "Recovery code" })).toHaveFocus();
    await userEvent.tab();
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
    // Shift+Tab goes to the control before it, as the browser does outside a dialog.
    screen.getByRole("radio", { name: "Recovery code" }).focus();
    await userEvent.tab({ shift: true });
    expect(screen.getByRole("radio", { name: "Computer password" })).toHaveFocus();
  });
});
