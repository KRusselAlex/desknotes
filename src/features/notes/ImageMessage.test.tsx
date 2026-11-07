import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { IMAGE_MESSAGE_MS, ImageMessage } from "./ImageMessage";

describe("ImageMessage", () => {
  afterEach(() => vi.useRealTimers());

  it.each([
    ["too_large", "That image is too large. Images can be up to 5 MB."],
    ["unsupported", "DeskNotes can add PNG, JPEG, GIF or WebP images."],
    ["failed", "That image could not be added."],
  ] as const)("shows the %s text verbatim as an alert", (problem, text) => {
    const { container } = render(<ImageMessage problem={problem} onDismiss={() => {}} />);
    const alert = screen.getByRole("alert");
    expect(alert).toHaveClass("dn-save-error");
    expect(alert).toHaveTextContent(text);
    expect(container.querySelector("svg")).not.toBeNull(); // the alert icon
  });

  it("closes itself after 8 s", () => {
    vi.useFakeTimers();
    const onDismiss = vi.fn();
    render(<ImageMessage problem="failed" onDismiss={onDismiss} />);
    expect(IMAGE_MESSAGE_MS).toBe(8000);
    act(() => vi.advanceTimersByTime(7999));
    expect(screen.getByRole("alert")).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("Dismiss closes it", async () => {
    const onDismiss = vi.fn();
    render(<ImageMessage problem="unsupported" onDismiss={onDismiss} />);
    await userEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
