import { StrictMode } from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { PrivacyStatus } from "../../types/note";

vi.mock("../../ipc/commands", () => ({
  commands: {
    privacyStatus: vi.fn(),
    forgotPinSystem: vi.fn(),
    recoverWithCode: vi.fn(),
    openSettings: vi.fn().mockResolvedValue(undefined),
  },
}));

import { commands } from "../../ipc/commands";
import { ForgotPin, normalizeRecoveryCode } from "./ForgotPin";

const status = (recovery: PrivacyStatus["recovery"]): PrivacyStatus => ({
  enabled: true,
  locked: true,
  lockAfterMinutes: 5,
  recovery,
  recoveryMethod: recovery === "none" ? null : recovery,
  systemAvailable: recovery === "system",
  resetAt: null,
});

function route(recovery: PrivacyStatus["recovery"]) {
  vi.mocked(commands.privacyStatus).mockResolvedValue(status(recovery));
}

const codeField = () => screen.getByRole("textbox", { name: "Recovery code" });
const continueButton = () => screen.getByRole("button", { name: "Continue" });

describe("ForgotPin", () => {
  beforeEach(() => vi.clearAllMocks());

  it("system_route_then_new_pin", async () => {
    route("system");
    vi.mocked(commands.forgotPinSystem).mockResolvedValue(true);
    const onClose = vi.fn();
    render(<ForgotPin onClose={onClose} />);
    await waitFor(() => expect(commands.openSettings).toHaveBeenCalledWith("privacy-new-pin"));
    expect(commands.forgotPinSystem).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(commands.recoverWithCode).not.toHaveBeenCalled();
  });

  it("asks the system once per press, also under StrictMode, and says what to do meanwhile", async () => {
    route("system");
    vi.mocked(commands.forgotPinSystem).mockReturnValue(new Promise(() => undefined));
    render(
      <StrictMode>
        <ForgotPin onClose={vi.fn()} />
      </StrictMode>,
    );
    expect(await screen.findByRole("dialog", { name: "Forgot your PIN?" })).toHaveTextContent(
      "Enter your computer password in the window that opens.",
    );
    expect(commands.forgotPinSystem).toHaveBeenCalledTimes(1);
  });

  it("cancelled_system_prompt_changes_nothing", async () => {
    route("system");
    vi.mocked(commands.forgotPinSystem).mockResolvedValue(false);
    const onClose = vi.fn();
    render(<ForgotPin onClose={onClose} />);
    const dialog = await screen.findByRole("dialog", { name: "Nothing was changed" });
    expect(dialog).toHaveTextContent("your PIN still unlocks private notes");
    expect(commands.openSettings).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();

    // Try again asks the system again; Back to PIN closes.
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(commands.forgotPinSystem).toHaveBeenCalledTimes(2));
    await userEvent.click(await screen.findByRole("button", { name: "Back to PIN" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(commands.openSettings).not.toHaveBeenCalled();
  });

  it("shows why the system route was refused", async () => {
    route("system");
    vi.mocked(commands.forgotPinSystem).mockRejectedValue(new Error("The Ubuntu password is already being asked for."));
    render(<ForgotPin onClose={vi.fn()} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("The Ubuntu password is already being asked for.");
    expect(commands.openSettings).not.toHaveBeenCalled();
  });

  it("recovery_code_route_accepts_any_spacing", async () => {
    route("code");
    vi.mocked(commands.recoverWithCode).mockResolvedValue({ kind: "ok" });
    const onClose = vi.fn();
    render(<ForgotPin onClose={onClose} />);
    expect(await screen.findByRole("dialog", { name: "Enter your recovery code" })).toHaveTextContent(
      "Dashes and spaces are added for you. Not case-sensitive.",
    );
    expect(commands.forgotPinSystem).not.toHaveBeenCalled();
    expect(continueButton()).toBeDisabled();

    await userEvent.type(codeField(), "k7qd m2xp-9wtr 4hnb--c6jf v8lz");
    expect(codeField()).toHaveValue("K7QDM2XP9WTR4HNBC6JFV8LZ");
    expect(continueButton()).toBeEnabled();
    await userEvent.click(continueButton());

    expect(commands.recoverWithCode).toHaveBeenCalledWith("K7QD-M2XP-9WTR-4HNB-C6JF-V8LZ");
    await waitFor(() => expect(commands.openSettings).toHaveBeenCalledWith("privacy-new-pin"));
    expect(onClose).toHaveBeenCalled();
  });

  it("shows the code in six groups of four as it is typed", async () => {
    route("code");
    const { container } = render(<ForgotPin onClose={vi.fn()} />);
    await userEvent.type(await screen.findByRole("textbox", { name: "Recovery code" }), "K7QDM2XR9FPAWT");
    const groups = [...container.querySelectorAll(".dn-code-group")].map((g) => g.textContent);
    expect(groups).toEqual(["K7QD", "M2XR", "9FPA", "WT", "····", "····"]);
    expect(container.querySelector(".dn-code-group.is-current")).toHaveTextContent("WT");
  });

  it("a wrong code says so and keeps it for correcting; Enter sends it", async () => {
    route("code");
    vi.mocked(commands.recoverWithCode).mockResolvedValue({ kind: "wrong", waitSecs: 0 });
    render(<ForgotPin onClose={vi.fn()} />);
    await userEvent.type(await screen.findByRole("textbox", { name: "Recovery code" }), "AAAABBBBCCCCDDDDEEEEFFFF{Enter}");
    expect(commands.recoverWithCode).toHaveBeenCalledWith("AAAA-BBBB-CCCC-DDDD-EEEE-FFFF");
    expect(await screen.findByRole("status")).toHaveTextContent("Wrong recovery code. Try again.");
    expect(codeField()).toHaveValue("AAAABBBBCCCCDDDDEEEEFFFF");
    expect(commands.openSettings).not.toHaveBeenCalled();
  });

  it("a wait disables Continue and counts down, like the PIN pad", async () => {
    route("code");
    vi.mocked(commands.recoverWithCode).mockResolvedValue({ kind: "wrong", waitSecs: 2 });
    render(<ForgotPin onClose={vi.fn()} />);
    await userEvent.type(await screen.findByRole("textbox", { name: "Recovery code" }), "AAAABBBBCCCCDDDDEEEEFFFF");
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    try {
      await act(async () => continueButton().click());
      expect(screen.getByRole("status")).toHaveTextContent("Wrong recovery code. Try again in 2 s");
      expect(continueButton()).toBeDisabled();
      await act(async () => vi.advanceTimersByTime(2_000));
      expect(screen.getByRole("status")).toHaveTextContent("");
      expect(continueButton()).toBeEnabled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("Back to PIN and Cancel leave without checking anything", async () => {
    route("code");
    const onClose = vi.fn();
    render(<ForgotPin onClose={onClose} />);
    await userEvent.click(await screen.findByRole("button", { name: "Back to PIN" }));
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(commands.recoverWithCode).not.toHaveBeenCalled();
  });

  it("with no way back, explains the last resort in plain words", async () => {
    route("none");
    const onClose = vi.fn();
    render(<ForgotPin onClose={onClose} />);
    const dialog = await screen.findByRole("dialog", { name: "Forgot your PIN?" });
    expect(dialog).toHaveTextContent("quit DeskNotes");
    expect(dialog).toHaveTextContent("desknotes --reset-pin");
    expect(commands.forgotPinSystem).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Back to PIN" }));
    expect(onClose).toHaveBeenCalled();
  });

  it("after the proof, calls onProved instead of onClose when given", async () => {
    route("system");
    vi.mocked(commands.forgotPinSystem).mockResolvedValue(true);
    const onClose = vi.fn();
    const onProved = vi.fn();
    render(<ForgotPin onClose={onClose} onProved={onProved} />);
    await waitFor(() => expect(onProved).toHaveBeenCalled());
    expect(onClose).not.toHaveBeenCalled();
  });

  it("normalizes a typed code to 24 letters and digits", () => {
    expect(normalizeRecoveryCode(" k7qd-m2xp 9wtr_4hnb.c6jf v8lz extra")).toBe("K7QDM2XP9WTR4HNBC6JFV8LZ");
  });
});
