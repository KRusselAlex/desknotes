import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReminderListRow } from "../../types/reminder";
import { RemindersList } from "./RemindersList";

// vitest runs in Node and can read stylesheets from disk. The module name is a variable
// so type-checking needs no Node typings, with or without @types/node installed.
const NODE_FS = "node:fs";
const { readFileSync } = (await import(/* @vite-ignore */ NODE_FS)) as { readFileSync: (path: string, encoding: "utf8") => string };

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

  it("keeps the overdue chip readable in the dark theme (R22)", () => {
    const css = readFileSync("src/styles/manager.css", "utf8"); // vitest blanks imported CSS
    expect(css).toMatch(/\n\.dn-rem-row\.is-overdue \.dn-rem-chip\s*\{\s*background:\s*var\(--dn-danger\);\s*color:\s*#fff;/);
    // The dark theme's danger is a pale red: dark ink on it, the same fill.
    const dark = /\[data-theme="dark"\] \.dn-rem-row\.is-overdue \.dn-rem-chip\s*\{([^}]*)\}/.exec(css)?.[1];
    expect(dark?.trim()).toBe("color: var(--dn-on-accent);");
  });
});
