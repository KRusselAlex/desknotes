import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { PrivacyStatus } from "../../types/note";

vi.mock("../../ipc/commands", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../ipc/commands")>();
  return {
    CommandError: actual.CommandError,
    commands: {
      privacyStatus: vi.fn(),
      setupPin: vi.fn(),
      chooseNewPin: vi.fn(),
      changePin: vi.fn(),
      turnOffLock: vi.fn(),
      setRecoveryMethod: vi.fn(),
      setLockAfter: vi.fn().mockResolvedValue(undefined),
      lockNow: vi.fn().mockResolvedValue(undefined),
    },
  };
});
vi.mock("../../ipc/events", () => ({
  onPrivacyChanged: () => Promise.resolve(() => undefined),
}));

import { CommandError, commands } from "../../ipc/commands";
import { PrivacyPane } from "./PrivacyPane";

const PIN = "246810";
const NEW_PIN = "135792";
const CODE = "K7QD-M2XP-9WTR-4HNB-C6JF-V8LZ";

const off: PrivacyStatus = {
  enabled: false,
  locked: false,
  lockAfterMinutes: 5,
  recovery: "none",
  recoveryMethod: null,
  systemAvailable: true,
  resetAt: null,
};
const on = (more: Partial<PrivacyStatus> = {}): PrivacyStatus => ({
  ...off,
  enabled: true,
  recovery: "system",
  recoveryMethod: "system",
  ...more,
});

function status(s: PrivacyStatus) {
  vi.mocked(commands.privacyStatus).mockResolvedValue(s);
}

const dialog = () => screen.getByRole("dialog");
const dots = () => within(dialog()).getByRole("img", { name: /of 6 digits/ });
const type = (pin: string) => userEvent.keyboard(pin);

async function turnOn() {
  render(<PrivacyPane />);
  await userEvent.click(await screen.findByRole("switch", { name: "Lock private notes with a PIN" }));
}

describe("PrivacyPane", () => {
  beforeEach(() => vi.clearAllMocks());

  it("wording_says_private_notes_and_does_not_encrypt", async () => {
    status(off);
    render(<PrivacyPane />);
    expect(await screen.findByText("Lock private notes with a PIN")).toBeInTheDocument();
    expect(
      screen.getByText("The lock hides your notes from people looking at your screen. It does not encrypt the notes file."),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Lock DeskNotes/)).toBeNull();
    // Nothing else until a PIN is set.
    expect(screen.queryByRole("radiogroup")).toBeNull();
    expect(screen.queryByRole("button", { name: /Lock now/ })).toBeNull();
  });

  it("turning_on_runs_choose_confirm_and_shows_code_when_issued", async () => {
    status({ ...off, systemAvailable: false });
    vi.mocked(commands.setupPin).mockResolvedValue({ recoveryCode: CODE });
    await turnOn();
    expect(screen.getByText("Set up lock · 1 of 3")).toBeInTheDocument();
    expect(screen.getByText("Choose a PIN")).toBeInTheDocument();
    // Only the recovery code can be the way back here: nothing to choose.
    expect(screen.queryByRole("radio", { name: "Use my computer password" })).toBeNull();
    await type("2468");
    expect(dots()).toHaveAccessibleName("4 of 6 digits");
    await type("10");
    expect(await screen.findByText("Confirm your PIN")).toBeInTheDocument();
    expect(screen.getByText("Set up lock · 2 of 3")).toBeInTheDocument();
    expect(commands.setupPin).not.toHaveBeenCalled();
    await type(PIN);
    await waitFor(() => expect(commands.setupPin).toHaveBeenCalledWith(PIN, "code"));

    expect(await screen.findByText("Save your recovery code")).toBeInTheDocument();
    const code = screen.getByRole("group", { name: "Recovery code" });
    expect(code).toHaveTextContent("K7QDM2XP9WTR4HNBC6JFV8LZ");
    expect(code.children).toHaveLength(6);
    expect(screen.getByText("3 · Recovery code")).toBeInTheDocument();
    // The PIN never reached the page.
    expect(document.body.innerHTML).not.toContain(PIN);

    const done = screen.getByRole("button", { name: "Turn on lock" });
    expect(done).toBeDisabled();
    await userEvent.click(screen.getByRole("checkbox", { name: "I've written it down" }));
    expect(done).toBeEnabled();
    status(on({ recovery: "code", recoveryMethod: "code", systemAvailable: false }));
    await userEvent.click(done);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.body.textContent).not.toContain("K7QD");
    expect(await screen.findByRole("switch", { name: "Lock private notes with a PIN" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
  });

  it("no_code_step_when_system_password_is_the_backup", async () => {
    status(off);
    vi.mocked(commands.setupPin).mockResolvedValue({ recoveryCode: null });
    await turnOn();
    expect(screen.getByText("Set up lock · 1 of 2")).toBeInTheDocument();
    // Default where it can work: the computer password.
    expect(screen.getByRole("radio", { name: "Use my computer password" })).toHaveAttribute("aria-checked", "true");
    await type(PIN);
    expect(await screen.findByText("Set up lock · 2 of 2")).toBeInTheDocument();
    await type(PIN);
    await waitFor(() => expect(commands.setupPin).toHaveBeenCalledWith(PIN, "system"));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.queryByText("Save your recovery code")).toBeNull();
  });

  it("the recovery code can be chosen at setup where the computer password works", async () => {
    status(off);
    vi.mocked(commands.setupPin).mockResolvedValue({ recoveryCode: CODE });
    await turnOn();
    await userEvent.click(screen.getByRole("radio", { name: "Use a recovery code" }));
    expect(screen.getByText("Set up lock · 1 of 3")).toBeInTheDocument();
    await type(PIN);
    await screen.findByText("Confirm your PIN");
    await type(PIN);
    await waitFor(() => expect(commands.setupPin).toHaveBeenCalledWith(PIN, "code"));
    expect(await screen.findByText("Save your recovery code")).toBeInTheDocument();
  });

  it("mismatch_keeps_step_two_with_message", async () => {
    status(off);
    await turnOn();
    await type(PIN);
    await screen.findByText("Confirm your PIN");
    await type("246811");
    expect(await screen.findByText("The PINs don't match. Enter it again.")).toBeInTheDocument();
    expect(screen.getByText("Confirm your PIN")).toBeInTheDocument();
    expect(screen.getByText("Set up lock · 2 of 2")).toBeInTheDocument();
    expect(dots()).toHaveAccessibleName("0 of 6 digits");
    expect(commands.setupPin).not.toHaveBeenCalled();
    // The first PIN is kept: typing it again finishes.
    vi.mocked(commands.setupPin).mockResolvedValue({ recoveryCode: null });
    await type(PIN);
    await waitFor(() => expect(commands.setupPin).toHaveBeenCalledWith(PIN, "system"));
  });

  it("weak_pin_is_explained", async () => {
    status(off);
    const message = "PIN must be 6 digits and not obvious (such as 000000 or 123456)";
    vi.mocked(commands.setupPin).mockRejectedValueOnce(new CommandError("validation", message));
    await turnOn();
    await type("123456");
    await screen.findByText("Confirm your PIN");
    await type("123456");
    // Back to choosing, with the core's explanation.
    expect(await screen.findByText(`${message}.`)).toBeInTheDocument();
    expect(screen.getByText("Choose a PIN")).toBeInTheDocument();
    expect(screen.getByText("Set up lock · 1 of 2")).toBeInTheDocument();
    vi.mocked(commands.setupPin).mockResolvedValue({ recoveryCode: null });
    await type(PIN);
    await screen.findByText("Confirm your PIN");
    await type(PIN);
    await waitFor(() => expect(commands.setupPin).toHaveBeenLastCalledWith(PIN, "system"));
  });

  it("cancelling set-up stores nothing", async () => {
    status(off);
    await turnOn();
    await type("246");
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(commands.setupPin).not.toHaveBeenCalled();
    expect(screen.getByRole("switch", { name: "Lock private notes with a PIN" })).toHaveAttribute("aria-checked", "false");
  });

  it("lock_after_options_are_1_5_10_15", async () => {
    status(on());
    render(<PrivacyPane />);
    const group = await screen.findByRole("radiogroup", { name: "Lock after inactivity" });
    const options = within(group).getAllByRole("radio");
    expect(options.map((o) => o.textContent)).toEqual(["1 min", "5 min", "10 min", "15 min"]);
    expect(within(group).getByRole("radio", { name: "5 min" })).toHaveAttribute("aria-checked", "true");
    await userEvent.click(within(group).getByRole("radio", { name: "15 min" }));
    expect(commands.setLockAfter).toHaveBeenCalledWith(15);
    expect(within(group).getByRole("radio", { name: "15 min" })).toHaveAttribute("aria-checked", "true");
  });

  it("locks now", async () => {
    status(on());
    render(<PrivacyPane />);
    await userEvent.click(await screen.findByRole("button", { name: "Lock now" }));
    expect(commands.lockNow).toHaveBeenCalledTimes(1);
  });

  it("offers a new recovery code only when the code is the way back", async () => {
    status(on());
    const { unmount } = render(<PrivacyPane />);
    await screen.findByRole("button", { name: "Change PIN…" });
    expect(screen.queryByRole("button", { name: "New recovery code…" })).toBeNull();
    unmount();

    status(on({ recovery: "code", recoveryMethod: "code" }));
    vi.mocked(commands.setRecoveryMethod).mockResolvedValue({ check: { kind: "ok" }, recoveryCode: CODE });
    render(<PrivacyPane />);
    await userEvent.click(await screen.findByRole("button", { name: "New recovery code…" }));
    await type(PIN);
    await waitFor(() => expect(commands.setRecoveryMethod).toHaveBeenCalledWith(PIN, "code"));
    expect(await screen.findByText(/Your old recovery code no longer works/)).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Recovery code" })).toHaveTextContent("K7QD");
  });

  it("the computer password is offered only where it can work", async () => {
    status(on({ systemAvailable: false, recovery: "code", recoveryMethod: "code" }));
    render(<PrivacyPane />);
    const group = await screen.findByRole("radiogroup", { name: "If I forget my PIN" });
    expect(within(group).queryByRole("radio", { name: "Use my computer password" })).toBeNull();
    expect(within(group).getByRole("radio", { name: "Use a recovery code" })).toHaveAttribute("aria-checked", "true");
  });

  it("switching to a recovery code asks for the PIN and shows the new code once", async () => {
    status(on());
    vi.mocked(commands.setRecoveryMethod)
      .mockResolvedValueOnce({ check: { kind: "wrong", waitSecs: 0 }, recoveryCode: null })
      .mockResolvedValueOnce({ check: { kind: "ok" }, recoveryCode: CODE });
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(<PrivacyPane />);
    await userEvent.click(await screen.findByRole("radio", { name: "Use a recovery code" }));
    expect(within(dialog()).getByText("Use a recovery code")).toBeInTheDocument();
    await type("111111");
    expect(await within(dialog()).findByText("Wrong PIN. Try again.")).toBeInTheDocument();
    await type(PIN);
    expect(await screen.findByText("Save your recovery code")).toBeInTheDocument();
    expect(commands.setRecoveryMethod).toHaveBeenLastCalledWith(PIN, "code");
    // Copied only on the explicit button.
    expect(writeText).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Copy" }));
    expect(writeText).toHaveBeenCalledWith(CODE);
    expect(await screen.findByRole("button", { name: "Copied" })).toBeInTheDocument();
    // The print copy holds only the code.
    expect(document.querySelector(".dn-print-only")).toHaveTextContent(`DeskNotes recovery code${CODE}`);
    status(on({ recovery: "code", recoveryMethod: "code" }));
    await userEvent.click(screen.getByRole("checkbox", { name: "I've written it down" }));
    await userEvent.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.querySelector(".dn-print-only")).toBeNull();
    expect(await screen.findByRole("radio", { name: "Use a recovery code" })).toHaveAttribute("aria-checked", "true");
  });

  it("switching to the computer password needs the PIN and shows no code", async () => {
    status(on({ recovery: "code", recoveryMethod: "code" }));
    vi.mocked(commands.setRecoveryMethod).mockResolvedValue({ check: { kind: "ok" }, recoveryCode: null });
    render(<PrivacyPane />);
    await userEvent.click(await screen.findByRole("radio", { name: "Use my computer password" }));
    status(on());
    await type(PIN);
    await waitFor(() => expect(commands.setRecoveryMethod).toHaveBeenCalledWith(PIN, "system"));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.queryByText("Save your recovery code")).toBeNull();
  });

  it("turning the lock off asks for the PIN and shows a wait", async () => {
    status(on());
    vi.mocked(commands.turnOffLock)
      .mockResolvedValueOnce({ kind: "wrong", waitSecs: 30 })
      .mockResolvedValueOnce({ kind: "ok" });
    render(<PrivacyPane />);
    await userEvent.click(await screen.findByRole("switch", { name: "Lock private notes with a PIN" }));
    expect(within(dialog()).getByText("Turn off the lock?")).toBeInTheDocument();
    await type("111111");
    expect(await within(dialog()).findByText(/Wrong PIN. Try again in 30 s/)).toBeInTheDocument();
    expect(commands.turnOffLock).toHaveBeenCalledWith("111111");
    await userEvent.click(within(dialog()).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("changes the PIN: current, new, confirm", async () => {
    status(on());
    vi.mocked(commands.changePin).mockResolvedValue({ kind: "ok" });
    render(<PrivacyPane />);
    await userEvent.click(await screen.findByRole("button", { name: "Change PIN…" }));
    expect(screen.getByText("Change PIN · 1 of 3")).toBeInTheDocument();
    expect(screen.getByText("Enter your current PIN")).toBeInTheDocument();
    expect(screen.getByText("Then choose and confirm the new one.")).toBeInTheDocument();
    await type(PIN);
    expect(await screen.findByText("Change PIN · 2 of 3")).toBeInTheDocument();
    await type(NEW_PIN);
    expect(await screen.findByText("Change PIN · 3 of 3")).toBeInTheDocument();
    await type(NEW_PIN);
    await waitFor(() => expect(commands.changePin).toHaveBeenCalledWith(PIN, NEW_PIN));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(await screen.findByText("Your PIN was changed.")).toBeInTheDocument();
  });

  it("a wrong current PIN goes back to step one and keeps the new PIN", async () => {
    status(on());
    vi.mocked(commands.changePin)
      .mockResolvedValueOnce({ kind: "wrong", waitSecs: 0 })
      .mockResolvedValueOnce({ kind: "ok" });
    render(<PrivacyPane />);
    await userEvent.click(await screen.findByRole("button", { name: "Change PIN…" }));
    await type("111111");
    await screen.findByText("Change PIN · 2 of 3");
    await type(NEW_PIN);
    await screen.findByText("Change PIN · 3 of 3");
    await type(NEW_PIN);
    expect(await screen.findByText("Change PIN · 1 of 3")).toBeInTheDocument();
    expect(screen.getByText("Wrong PIN. Try again.")).toBeInTheDocument();
    await type(PIN);
    await waitFor(() => expect(commands.changePin).toHaveBeenLastCalledWith(PIN, NEW_PIN));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("after another error, goes back to step one with the new PIN kept, so it can be tried again (DES-30)", async () => {
    status(on());
    vi.mocked(commands.changePin)
      .mockRejectedValueOnce(new CommandError("internal", "database is busy"))
      .mockResolvedValueOnce({ kind: "ok" });
    render(<PrivacyPane />);
    await userEvent.click(await screen.findByRole("button", { name: "Change PIN…" }));
    await type(PIN);
    await screen.findByText("Change PIN · 2 of 3");
    await type(NEW_PIN);
    await screen.findByText("Change PIN · 3 of 3");
    await type(NEW_PIN);
    expect(await screen.findByText("Change PIN · 1 of 3")).toBeInTheDocument();
    expect(screen.getByText("Database is busy.")).toBeInTheDocument();
    await type(PIN);
    await waitFor(() => expect(commands.changePin).toHaveBeenLastCalledWith(PIN, NEW_PIN));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("opens choose-a-new-PIN when asked (after a forgotten-PIN proof)", async () => {
    status(on({ recovery: "code", recoveryMethod: "code" }));
    vi.mocked(commands.chooseNewPin).mockResolvedValue({ recoveryCode: CODE });
    const started = vi.fn();
    render(<PrivacyPane startNewPin onNewPinStarted={started} />);
    expect(await screen.findByText("New PIN · 1 of 3")).toBeInTheDocument();
    expect(started).toHaveBeenCalled();
    expect(screen.getByText("Choose a new PIN")).toBeInTheDocument();
    // The "If I forget my PIN" choice is kept, not asked again.
    expect(within(dialog()).queryByRole("radiogroup")).toBeNull();
    await type(NEW_PIN);
    await screen.findByText("Confirm your new PIN");
    await type(NEW_PIN);
    await waitFor(() => expect(commands.chooseNewPin).toHaveBeenCalledWith(NEW_PIN));
    expect(commands.setupPin).not.toHaveBeenCalled();
    expect(await screen.findByText("Save your recovery code")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Done" })).toBeDisabled();
  });

  describe("while a call that may issue a code is running", () => {
    function deferred<T>() {
      let resolve!: (v: T) => void;
      const promise = new Promise<T>((r) => (resolve = r));
      return { promise, resolve };
    }

    it("set-up cannot be cancelled until setupPin answers", async () => {
      status({ ...off, systemAvailable: false });
      const call = deferred<{ recoveryCode: string | null }>();
      vi.mocked(commands.setupPin).mockReturnValue(call.promise);
      await turnOn();
      await type(PIN);
      await screen.findByText("Confirm your PIN");
      await type(PIN);
      await waitFor(() => expect(commands.setupPin).toHaveBeenCalled());
      const cancel = within(dialog()).getByRole("button", { name: "Cancel" });
      expect(cancel).toBeDisabled();
      await userEvent.click(cancel);
      await userEvent.keyboard("{Escape}");
      expect(screen.getByRole("dialog")).toBeInTheDocument();
      call.resolve({ recoveryCode: CODE });
      expect(await screen.findByText("Save your recovery code")).toBeInTheDocument();
      expect(screen.getByRole("group", { name: "Recovery code" })).toHaveTextContent("K7QD");
    });

    it("a new recovery code cannot be cancelled until setRecoveryMethod answers", async () => {
      status(on({ recovery: "code", recoveryMethod: "code" }));
      const call = deferred<{ check: { kind: "ok" }; recoveryCode: string | null }>();
      vi.mocked(commands.setRecoveryMethod).mockReturnValue(call.promise);
      render(<PrivacyPane />);
      await userEvent.click(await screen.findByRole("button", { name: "New recovery code…" }));
      await type(PIN);
      await waitFor(() => expect(commands.setRecoveryMethod).toHaveBeenCalledWith(PIN, "code"));
      const cancel = within(dialog()).getByRole("button", { name: "Cancel" });
      expect(cancel).toBeDisabled();
      await userEvent.click(cancel);
      await userEvent.keyboard("{Escape}");
      expect(screen.getByRole("dialog")).toBeInTheDocument();
      call.resolve({ check: { kind: "ok" }, recoveryCode: CODE });
      expect(await screen.findByText("Save your recovery code")).toBeInTheDocument();
      // The code view itself cannot be dismissed without "I've written it down".
      await userEvent.keyboard("{Escape}");
      expect(screen.getByRole("group", { name: "Recovery code" })).toBeInTheDocument();
    });

    it("Cancel works again once a wrong PIN has been answered", async () => {
      status(on({ recovery: "code", recoveryMethod: "code" }));
      const call = deferred<{ check: { kind: "wrong"; waitSecs: number }; recoveryCode: null }>();
      vi.mocked(commands.setRecoveryMethod).mockReturnValue(call.promise);
      render(<PrivacyPane />);
      await userEvent.click(await screen.findByRole("button", { name: "New recovery code…" }));
      await type("111111");
      expect(within(dialog()).getByRole("button", { name: "Cancel" })).toBeDisabled();
      call.resolve({ check: { kind: "wrong", waitSecs: 0 }, recoveryCode: null });
      expect(await within(dialog()).findByText("Wrong PIN. Try again.")).toBeInTheDocument();
      await userEvent.click(within(dialog()).getByRole("button", { name: "Cancel" }));
      expect(screen.queryByRole("dialog")).toBeNull();
    });

    it("Change PIN cannot be cancelled until changePin answers", async () => {
      status(on());
      const call = deferred<{ kind: "ok" }>();
      vi.mocked(commands.changePin).mockReturnValue(call.promise);
      render(<PrivacyPane />);
      await userEvent.click(await screen.findByRole("button", { name: "Change PIN…" }));
      await type(PIN);
      await screen.findByText("Change PIN · 2 of 3");
      await type(NEW_PIN);
      await screen.findByText("Change PIN · 3 of 3");
      await type(NEW_PIN);
      expect(within(dialog()).getByRole("button", { name: "Cancel" })).toBeDisabled();
      await userEvent.keyboard("{Escape}");
      expect(screen.getByRole("dialog")).toBeInTheDocument();
      call.resolve({ kind: "ok" });
      expect(await screen.findByText("Your PIN was changed.")).toBeInTheDocument();
    });
  });
});

