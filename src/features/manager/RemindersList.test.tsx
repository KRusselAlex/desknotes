import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReminderListRow } from "../../types/reminder";
import { RemindersList } from "./RemindersList";

const now = new Date(2026, 10, 4, 12, 0).getTime();
const row = (over: Partial<ReminderListRow> = {}): ReminderListRow => ({
  noteId: "n1",
  title: "Stand-up notes",
  color: "#cfe8ff",
  repeat: "weekdays",
  dueAt: new Date(2026, 10, 4, 14, 0).getTime(),
  overdue: false,
  locked: false,
  archived: false,
  ...over,
});

describe("RemindersList", () => {
  it("shows each row's title, repeat and time under its group", () => {
    render(
      <RemindersList
        rows={[
          row({ noteId: "a", title: "Call back", repeat: "none", overdue: true, dueAt: new Date(2026, 10, 4, 9, 30).getTime() }),
          row({ noteId: "b" }),
          row({ noteId: "c", title: "Bike repair", repeat: "none", dueAt: new Date(2026, 10, 5, 8, 45).getTime() }),
        ]}
        now={now}
        query=""
        onOpen={() => undefined}
      />,
    );
    expect(screen.getByText("Today")).toBeInTheDocument();
    expect(screen.getByText("Tomorrow")).toBeInTheDocument();
    expect(screen.queryByText("Later")).toBeNull();
    const [overdue, standup, bike] = screen.getAllByRole("listitem");
    expect(overdue).toHaveTextContent("Call back");
    expect(overdue).toHaveTextContent("Overdue · 09:30");
    expect(overdue).not.toHaveTextContent("Weekdays");
    expect(overdue).toHaveClass("is-overdue");
    expect(standup).toHaveTextContent("Stand-up notes");
    expect(standup).toHaveTextContent("Weekdays");
    expect(standup).toHaveTextContent("14:00");
    expect(standup).not.toHaveClass("is-overdue");
    expect(bike).toHaveTextContent("08:45");
  });

  it("opens the note with the row's button, by click or Enter", async () => {
    const onOpen = vi.fn();
    render(<RemindersList rows={[row()]} now={now} query="" onOpen={onOpen} />);
    const button = within(screen.getByRole("listitem")).getByRole("button");
    await userEvent.click(button);
    expect(onOpen).toHaveBeenLastCalledWith(row());
    await userEvent.tab();
    button.focus();
    await userEvent.keyboard("{Enter}");
    expect(onOpen).toHaveBeenCalledTimes(2);
  });

  it("highlights the search text in the title", () => {
    const { container } = render(<RemindersList rows={[row()]} now={now} query="stand" onOpen={() => undefined} />);
    expect(container.querySelector("mark")).toHaveTextContent("Stand");
  });
});
