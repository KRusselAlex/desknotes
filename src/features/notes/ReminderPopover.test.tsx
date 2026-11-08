import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReminderView } from "../../types/reminder";

vi.mock("../../ipc/commands", async (importOriginal) => ({
  CommandError: (await importOriginal<typeof import("../../ipc/commands")>()).CommandError,
  commands: {
    setReminder: vi.fn(),
    removeReminder: vi.fn().mockResolvedValue(undefined),
  },
}));

import { CommandError, commands } from "../../ipc/commands";
import { ReminderPopover } from "./ReminderPopover";

const ID = "2f1c8f0e-6a8b-4c51-9d4e-2b8f5f1a9c3d";
const existing: ReminderView = { date: "2026-11-10", time: "14:00", repeat: "weekly", dueAt: 1, overdue: false };

function renderPopover(initial: ReminderView | null = existing, onClose = vi.fn()) {
  render(<ReminderPopover noteId={ID} initial={initial} onClose={onClose} />);
  return onClose;
}

const dateInput = () => screen.getByLabelText("Date") as HTMLInputElement;
const timeInput = () => screen.getByLabelText("Time") as HTMLInputElement;

describe("ReminderPopover", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(commands.setReminder).mockResolvedValue(existing);
    vi.mocked(commands.removeReminder).mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows the reminder's date, time and repeat as the design's dialog", () => {
    renderPopover();
    expect(screen.getByRole("dialog", { name: "Reminder" })).toBeInTheDocument();
    expect(dateInput()).toHaveValue("2026-11-10");
    expect(timeInput()).toHaveValue("14:00");
    expect(screen.getByText("Repeat")).toBeInTheDocument();
    const group = screen.getByRole("radiogroup", { name: "Repeat" });
    const labels = Array.from(group.querySelectorAll('[role="radio"]')).map((r) => r.textContent);
    expect(labels).toEqual(["None", "Daily", "Weekdays", "Weekly", "Monthly"]);
    expect(screen.getByRole("radio", { name: "Weekly" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("button", { name: "Save" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove" })).toBeInTheDocument();
  });

  it("starts a new reminder at the next whole hour with Repeat None, and has no Remove", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 10, 4, 10, 15));
    renderPopover(null);
    expect(dateInput()).toHaveValue("2026-11-04");
    expect(timeInput()).toHaveValue("11:00");
    expect(screen.getByRole("radio", { name: "None" })).toHaveAttribute("aria-checked", "true");
    expect(screen.queryByRole("button", { name: "Remove" })).toBeNull();
  });

  it("starts at 09:00 tomorrow late in the evening", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 10, 4, 22, 30));
    renderPopover(null);
    expect(dateInput()).toHaveValue("2026-11-05");
    expect(timeInput()).toHaveValue("09:00");
  });

  // WebKitGTK's native time field never moves on from the hour: typing "0930" there left
  // "12:00". A text field reads the time the way people type it.
  it("reads the time as it is typed, in one go", async () => {
    renderPopover();
    expect(timeInput()).toHaveAttribute("type", "text");
    await userEvent.clear(timeInput());
    await userEvent.type(timeInput(), "0930");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(commands.setReminder).toHaveBeenCalledWith(ID, "2026-11-10", "09:30", "weekly");
  });

  it("reads a 12-hour time too", async () => {
    renderPopover();
    await userEvent.clear(timeInput());
    await userEvent.type(timeInput(), "9:30 pm");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(commands.setReminder).toHaveBeenCalledWith(ID, "2026-11-10", "21:30", "weekly");
  });

  it("shows the time it read once the field is left", async () => {
    renderPopover();
    await userEvent.clear(timeInput());
    await userEvent.type(timeInput(), "930");
    expect(timeInput()).toHaveValue("930");
    await userEvent.tab();
    expect(timeInput()).toHaveValue("09:30");
  });

  it("marks a time it cannot read, keeps it for correcting, and does not save", async () => {
    renderPopover();
    expect(timeInput()).not.toHaveAttribute("aria-invalid", "true");
    await userEvent.clear(timeInput());
    await userEvent.type(timeInput(), "25:00");
    await userEvent.tab();
    expect(timeInput()).toHaveAttribute("aria-invalid", "true");
    expect(timeInput()).toHaveValue("25:00");
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    await userEvent.clear(timeInput());
    await userEvent.type(timeInput(), "14:45");
    expect(timeInput()).not.toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
  });

  it("does not save without a time", async () => {
    renderPopover();
    await userEvent.clear(timeInput());
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("saves the date, time and repeat that were picked, then closes", async () => {
    const onClose = renderPopover();
    fireEvent.change(dateInput(), { target: { value: "2026-12-01" } });
    fireEvent.change(timeInput(), { target: { value: "08:45" } });
    await userEvent.click(screen.getByRole("radio", { name: "Monthly" }));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(commands.setReminder).toHaveBeenCalledWith(ID, "2026-12-01", "08:45", "monthly");
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("removes the reminder, then closes", async () => {
    const onClose = renderPopover();
    await userEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(commands.removeReminder).toHaveBeenCalledWith(ID);
    expect(commands.setReminder).not.toHaveBeenCalled();
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("shows a refusal under the inputs and stays open", async () => {
    vi.mocked(commands.setReminder).mockRejectedValue(new CommandError("validation", "Pick a time in the future."));
    const onClose = renderPopover();
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Pick a time in the future.");
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Reminder" })).toBeInTheDocument();
  });

  it("shows the far-away refusal too, and clears it when the date changes", async () => {
    vi.mocked(commands.setReminder).mockRejectedValue(new CommandError("validation", "This reminder is too far away."));
    renderPopover();
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("This reminder is too far away.");
    fireEvent.change(dateInput(), { target: { value: "2026-12-01" } });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows a failed removal and stays open", async () => {
    vi.mocked(commands.removeReminder).mockRejectedValue(new CommandError("not_allowed", "Unlock private notes first."));
    const onClose = renderPopover();
    await userEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Unlock private notes first.");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("does not save without a date or a time", async () => {
    renderPopover();
    fireEvent.change(dateInput(), { target: { value: "" } });
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(commands.setReminder).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("closes on Escape", async () => {
    const onClose = renderPopover();
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalled();
  });

  it("closes on a click outside, not on a click inside", async () => {
    const onClose = renderPopover();
    await userEvent.click(screen.getByText("Repeat"));
    expect(onClose).not.toHaveBeenCalled();
    await userEvent.click(document.body);
    expect(onClose).toHaveBeenCalled();
  });

  it("does not close on a click on the chip that toggles it", async () => {
    const onClose = vi.fn();
    render(
      <>
        <button data-popover-toggle>chip</button>
        <ReminderPopover noteId={ID} initial={existing} onClose={onClose} />
      </>,
    );
    await userEvent.click(screen.getByText("chip"));
    expect(onClose).not.toHaveBeenCalled();
  });
});
