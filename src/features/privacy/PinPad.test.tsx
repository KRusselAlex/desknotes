import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { PinCheck } from "../../types/note";

vi.mock("../../ipc/commands", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../ipc/commands")>();
  return { CommandError: actual.CommandError, commands: { unlock: vi.fn() } };
});

import { CommandError, commands } from "../../ipc/commands";
import { PinPad } from "./PinPad";

const PIN = "482915";

function setup() {
  const onUnlocked = vi.fn();
  const onForgot = vi.fn();
  const view = render(<PinPad onUnlocked={onUnlocked} onForgot={onForgot} />);
  return { ...view, onUnlocked, onForgot };
}

const dots = () => screen.getByRole("img", { name: /of 6 digits/ });
const key = (name: string) => screen.getByRole("button", { name });
const digitKeys = () => ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"].map((d) => key(d));

async function clickPin(pin: string) {
  for (const d of pin) await userEvent.click(key(d));
}

describe("PinPad", () => {
  beforeEach(() => vi.clearAllMocks());

  it("shows filled dots only, never the digits typed", async () => {
    vi.mocked(commands.unlock).mockReturnValue(new Promise<PinCheck>(() => undefined)); // still checking
    const { container } = setup();
    expect(dots()).toHaveAccessibleName("0 of 6 digits");
    await clickPin("482");
    expect(dots()).toHaveAccessibleName("3 of 6 digits");
    expect(container.querySelectorAll(".dn-pin-dot.is-filled")).toHaveLength(3);
    expect(container.querySelector("input")).toBeNull();
    await clickPin("915");
    // Submitted: nothing in the DOM holds the PIN.
    expect(container.innerHTML).not.toContain(PIN);
    expect(container.textContent).not.toMatch(/48|29|91/);
  });

  it("unlocks after six digits typed on the keyboard", async () => {
    vi.mocked(commands.unlock).mockResolvedValue({ kind: "ok" });
    const { onUnlocked } = setup();
    await userEvent.keyboard("4829");
    await userEvent.keyboard("{Backspace}");
    expect(dots()).toHaveAccessibleName("3 of 6 digits");
    await userEvent.keyboard("915");
    expect(commands.unlock).toHaveBeenCalledWith(PIN);
    expect(commands.unlock).toHaveBeenCalledTimes(1);
    expect(onUnlocked).toHaveBeenCalledTimes(1);
  });

  it("deletes a digit with the delete key on the pad", async () => {
    setup();
    await clickPin("48");
    await userEvent.click(key("Delete digit"));
    expect(dots()).toHaveAccessibleName("1 of 6 digits");
  });

  it("clears the digits and says so after a wrong PIN without a wait", async () => {
    vi.mocked(commands.unlock).mockResolvedValue({ kind: "wrong", waitSecs: 0 });
    const { onUnlocked } = setup();
    await clickPin(PIN);
    expect(await screen.findByRole("status")).toHaveTextContent("Wrong PIN. Try again.");
    expect(dots()).toHaveAccessibleName("0 of 6 digits");
    expect(onUnlocked).not.toHaveBeenCalled();
    for (const k of digitKeys()) expect(k).toBeEnabled();
    // Typing again starts a new PIN and clears the message.
    await userEvent.keyboard("1");
    expect(dots()).toHaveAccessibleName("1 of 6 digits");
    expect(screen.queryByText("Wrong PIN. Try again.")).toBeNull();
  });

  it("wrong_pin_shows_countdown_and_disables_keys", async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(commands.unlock).mockResolvedValue({ kind: "wrong", waitSecs: 30 });
      const { onUnlocked } = setup();
      for (const d of PIN) fireEvent.keyDown(window, { key: d });
      await act(async () => undefined);

      expect(screen.getByRole("status")).toHaveTextContent("Wrong PIN. Try again in 30 s");
      expect(dots()).toHaveAccessibleName("0 of 6 digits");
      for (const k of [...digitKeys(), key("Delete digit")]) expect(k).toBeDisabled();
      // Typing is ignored during the wait.
      fireEvent.keyDown(window, { key: "1" });
      expect(dots()).toHaveAccessibleName("0 of 6 digits");

      act(() => vi.advanceTimersByTime(1000));
      expect(screen.getByRole("status")).toHaveTextContent("Try again in 29 s");
      act(() => vi.advanceTimersByTime(29_000));
      for (const k of digitKeys()) expect(k).toBeEnabled();
      expect(screen.queryByText(/Try again in/)).toBeNull();
      fireEvent.keyDown(window, { key: "1" });
      expect(dots()).toHaveAccessibleName("1 of 6 digits");
      expect(onUnlocked).not.toHaveBeenCalled();
      expect(commands.unlock).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("counts down a wait that was already running", async () => {
    vi.mocked(commands.unlock).mockResolvedValue({ kind: "waiting", waitSecs: 61 });
    setup();
    await clickPin(PIN);
    const status = await screen.findByRole("status");
    expect(status).toHaveTextContent("Try again in 61 s");
    expect(status).not.toHaveTextContent("Wrong PIN");
    expect(key("5")).toBeDisabled();
  });

  it("shows a refusal from the native side and lets the person try again", async () => {
    vi.mocked(commands.unlock).mockRejectedValue(new CommandError("not_allowed", "nothing is set to check"));
    setup();
    await clickPin(PIN);
    expect(await screen.findByRole("status")).toHaveTextContent("Nothing is set to check");
    expect(dots()).toHaveAccessibleName("0 of 6 digits");
    expect(key("5")).toBeEnabled();
  });

  it("does not take digits typed into a text field or with Ctrl", () => {
    setup();
    fireEvent.keyDown(window, { key: "1", ctrlKey: true });
    const field = document.createElement("input");
    document.body.append(field);
    fireEvent.keyDown(field, { key: "2" });
    field.remove();
    expect(dots()).toHaveAccessibleName("0 of 6 digits");
  });

  it("offers Forgot your PIN?", async () => {
    const { onForgot } = setup();
    await userEvent.click(screen.getByRole("button", { name: "Forgot your PIN?" }));
    expect(onForgot).toHaveBeenCalledTimes(1);
  });

  describe("in a Settings dialog", () => {
    it("is typed on the keyboard, checked by the caller and never calls unlock", async () => {
      const check = vi.fn().mockResolvedValue({ kind: "ok" });
      const onUnlocked = vi.fn();
      const { container } = render(<PinPad variant="app" label="Your PIN" check={check} onUnlocked={onUnlocked} />);
      expect(screen.getByRole("group", { name: "Your PIN" })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "5" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Forgot your PIN?" })).toBeNull();
      await userEvent.keyboard(PIN);
      expect(check).toHaveBeenCalledWith(PIN);
      expect(commands.unlock).not.toHaveBeenCalled();
      expect(onUnlocked).toHaveBeenCalledTimes(1);
      expect(container.innerHTML).not.toContain(PIN);
    });

    it("shows a notice it was opened with and marks the dots after an error", async () => {
      const { container } = render(
        <PinPad variant="app" notice="The PINs don't match. Enter it again." check={vi.fn()} onUnlocked={vi.fn()} />,
      );
      expect(screen.getByRole("status")).toHaveTextContent("The PINs don't match. Enter it again.");
      expect(container.querySelector(".dn-pinpad")).toHaveClass("has-error");
      await userEvent.keyboard("1");
      expect(screen.queryByText(/don't match/)).toBeNull();
      expect(container.querySelector(".dn-pinpad")).not.toHaveClass("has-error");
    });

    it("starts a wait it was opened with", () => {
      render(<PinPad variant="app" notice={{ kind: "wrong", waitSecs: 60 }} check={vi.fn()} onUnlocked={vi.fn()} />);
      expect(screen.getByRole("status")).toHaveTextContent("Wrong PIN. Try again in 60 s");
      fireEvent.keyDown(window, { key: "1" });
      expect(dots()).toHaveAccessibleName("0 of 6 digits");
    });

    it("just clears the entry when the caller moved on", async () => {
      const check = vi.fn().mockResolvedValue(null);
      const onUnlocked = vi.fn();
      render(<PinPad variant="app" check={check} onUnlocked={onUnlocked} />);
      await userEvent.keyboard(PIN);
      expect(dots()).toHaveAccessibleName("0 of 6 digits");
      expect(onUnlocked).not.toHaveBeenCalled();
      expect(screen.getByRole("status")).toBeEmptyDOMElement();
    });
  });
});

