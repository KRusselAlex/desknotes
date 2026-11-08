import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Segmented } from "./Segmented";

const OPTIONS = [
  { value: 1, label: "1 min" },
  { value: 5, label: "5 min" },
  { value: 10, label: "10 min" },
] as const;

const radio = (name: string) => screen.getByRole("radio", { name });

describe("Segmented", () => {
  it("only the chosen option is in the Tab order (DES-30)", () => {
    render(<Segmented label="Lock after" options={OPTIONS} value={5} onChange={vi.fn()} />);
    expect(radio("5 min")).toHaveAttribute("tabindex", "0");
    expect(radio("1 min")).toHaveAttribute("tabindex", "-1");
    expect(radio("10 min")).toHaveAttribute("tabindex", "-1");
  });

  it("with nothing chosen, the first option is in the Tab order", () => {
    render(<Segmented label="Lock after" options={OPTIONS} value={null} onChange={vi.fn()} />);
    expect(radio("1 min")).toHaveAttribute("tabindex", "0");
    expect(radio("5 min")).toHaveAttribute("tabindex", "-1");
  });

  it("arrow keys move between options, wrapping, and Space chooses", async () => {
    const onChange = vi.fn();
    render(<Segmented label="Lock after" options={OPTIONS} value={5} onChange={onChange} />);
    await userEvent.tab();
    expect(radio("5 min")).toHaveFocus();
    await userEvent.keyboard("{ArrowRight}");
    expect(radio("10 min")).toHaveFocus();
    await userEvent.keyboard("{ArrowRight}");
    expect(radio("1 min")).toHaveFocus();
    await userEvent.keyboard("{ArrowLeft}{ArrowUp}");
    expect(radio("5 min")).toHaveFocus();
    await userEvent.keyboard("{End}");
    expect(radio("10 min")).toHaveFocus();
    await userEvent.keyboard("{Home}");
    expect(radio("1 min")).toHaveFocus();
    expect(onChange).not.toHaveBeenCalled();
    await userEvent.keyboard(" ");
    expect(onChange).toHaveBeenCalledWith(1);
  });
});
