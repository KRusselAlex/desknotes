import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { NoteSummary, PrivacyStatus } from "../../types/note";
import type { ReminderListRow } from "../../types/reminder";
import { doneDateLabel } from "../../app/time";

const quitBlocked: { handler?: (count: number) => void } = {};
const privacyChanged: { handler?: (e: { locked: boolean }) => void } = {};
const remindersChanged: { handler?: (e: { noteId: string | null }) => void } = {};
vi.mock("../../ipc/events", () => ({
  onNotesChanged: () => Promise.resolve(() => undefined),
  onPrivacyChanged: (h: (e: { locked: boolean }) => void) => {
    privacyChanged.handler = h;
    return Promise.resolve(() => undefined);
  },
  onRemindersChanged: (h: (e: { noteId: string | null }) => void) => {
    remindersChanged.handler = h;
    return Promise.resolve(() => undefined);
  },
  onActionFailed: () => Promise.resolve(() => undefined),
  onQuitBlocked: (h: (count: number) => void) => {
    quitBlocked.handler = h;
    return Promise.resolve(() => undefined);
  },
}));
vi.mock("../../ipc/commands", async (importOriginal) => ({
  CommandError: (await importOriginal<typeof import("../../ipc/commands")>()).CommandError,
  commands: {
    listNotes: vi.fn(),
    noteCounts: vi.fn(),
    listReminders: vi.fn(),
    startupErrors: vi.fn(),
    createNote: vi.fn().mockResolvedValue({}),
    showNote: vi.fn().mockResolvedValue(undefined),
    hideNote: vi.fn().mockResolvedValue(undefined),
    setArchived: vi.fn().mockResolvedValue(undefined),
    setNoteCompleted: vi.fn().mockResolvedValue(undefined),
    restoreNote: vi.fn().mockResolvedValue(undefined),
    purgeNote: vi.fn().mockResolvedValue(undefined),
    trashNote: vi.fn().mockResolvedValue(undefined),
    quitApp: vi.fn(),
    openSettings: vi.fn().mockResolvedValue(undefined),
    hiddenNoteCount: vi.fn(),
    hideAllNotes: vi.fn().mockResolvedValue(2),
    showHiddenNotes: vi.fn().mockResolvedValue(2),
    privacyStatus: vi.fn(),
    lockNow: vi.fn().mockResolvedValue(undefined),
    acknowledgePinReset: vi.fn().mockResolvedValue(undefined),
  },
}));

import { CommandError, commands } from "../../ipc/commands";
import { ManagerWindow, highlight } from "./ManagerWindow";

const note = (over: Partial<NoteSummary> = {}): NoteSummary => ({
  id: "n1",
  title: "Weekend errands",
  color: "#fff4a3",
  updatedAt: Date.now(),
  archivedAt: null,
  deletedAt: null,
  completedAt: null,
  visible: true,
  snippet: null,
  private: false,
  privateLabel: "",
  locked: false,
  ...over,
});

const privacy = (over: Partial<PrivacyStatus> = {}): PrivacyStatus => ({
  enabled: false,
  locked: false,
  lockAfterMinutes: 5,
  recovery: "none",
  recoveryMethod: null,
  systemAvailable: true,
  resetAt: null,
  ...over,
});

describe("ManagerWindow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(commands.privacyStatus).mockResolvedValue(privacy());
    vi.mocked(commands.noteCounts).mockResolvedValue({ active: 1, completed: 0, archived: 0, trash: 1 });
    vi.mocked(commands.startupErrors).mockResolvedValue([]);
    vi.mocked(commands.hiddenNoteCount).mockResolvedValue(0);
    vi.mocked(commands.listReminders).mockResolvedValue([]);
  });

  it("lists active notes with counts and shows a note when its row is clicked", async () => {
    vi.mocked(commands.listNotes).mockResolvedValue([note()]);
    render(<ManagerWindow />);
    const row = await screen.findByRole("listitem");
    expect(within(row).getByText("Weekend errands")).toBeInTheDocument();
    expect(within(row).getByText(/On desktop/)).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /Active/ })).toHaveTextContent("1");
    await userEvent.click(row);
    expect(commands.showNote).toHaveBeenCalledWith("n1");
  });

  it("searches and highlights the match in the snippet", async () => {
    vi.mocked(commands.listNotes).mockResolvedValue([note({ snippet: "Pick up the bike before 5" })]);
    render(<ManagerWindow />);
    await userEvent.type(screen.getByRole("searchbox", { name: "Search notes" }), "bike");
    await waitFor(() => expect(commands.listNotes).toHaveBeenLastCalledWith("active", "bike"));
    expect(await screen.findByText("bike", { selector: "mark" })).toBeInTheDocument();
    expect(screen.getByText("1 note in Active")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Clear search" }));
    expect(screen.getByRole("searchbox")).toHaveValue("");
  });

  it("asks for confirmation before permanent deletion and focuses Cancel", async () => {
    vi.mocked(commands.listNotes).mockResolvedValue([note({ deletedAt: Date.now() })]);
    render(<ManagerWindow />);
    await userEvent.click(screen.getByRole("tab", { name: /Trash/ }));
    await userEvent.click(await screen.findByRole("button", { name: "Delete permanently" }));
    expect(commands.purgeNote).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();

    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(commands.purgeNote).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "Delete permanently" }));
    await userEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(commands.purgeNote).toHaveBeenCalledWith("n1");
  });

  it("shows an empty state per tab", async () => {
    vi.mocked(commands.listNotes).mockResolvedValue([]);
    render(<ManagerWindow />);
    expect(await screen.findByText("No notes yet. Press Ctrl+N to create one.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("tab", { name: /Archived/ }));
    expect(await screen.findByText("Nothing archived.")).toBeInTheDocument();
  });

  it("says what an Active search leaves out, and nothing of the sort on other tabs", async () => {
    vi.mocked(commands.listNotes).mockResolvedValue([]);
    render(<ManagerWindow />);
    await userEvent.type(screen.getByRole("searchbox", { name: "Search notes" }), "zzz");
    expect(await screen.findByText("Completed, archived and trashed notes are not included.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("tab", { name: /Archived/ }));
    expect(await screen.findByText("Try another tab or other words.")).toBeInTheDocument();
  });

  describe("Completed tab", () => {
    // Wed 4 Nov 2026, 12:00 local. Only the clock is faked, so timers and user events run as usual.
    const NOW = new Date(2026, 10, 4, 12, 0).getTime();
    const at = (y: number, m: number, d: number, h = 9, min = 15) => new Date(y, m, d, h, min).getTime();
    const done = (over: Partial<NoteSummary> = {}) => note({ id: "d1", title: "Book the dentist", completedAt: NOW - 1000, ...over });
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(NOW);
    });
    afterEach(() => vi.useRealTimers());

    it("sits between Active and Reminders with its own count", async () => {
      vi.mocked(commands.listNotes).mockResolvedValue([]);
      vi.mocked(commands.noteCounts).mockResolvedValue({ active: 1, completed: 4, archived: 2, trash: 0 });
      render(<ManagerWindow />);
      await screen.findByText("No notes yet. Press Ctrl+N to create one.");
      expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual(["Active1", "Completed4", "Reminders", "Archived2", "Trash"]);
    });

    it("lists completed notes with a Done date and a Reopen button", async () => {
      const dates = [
        NOW - 1000, // today
        at(2026, 10, 3), // yesterday
        at(2026, 10, 1), // Sunday, within 6 days
        at(2026, 9, 28), // exactly 7 days ago: a date, not a weekday
        at(2025, 0, 2), // another year
      ];
      vi.mocked(commands.listNotes).mockImplementation(async (f) =>
        f === "completed" ? dates.map((completedAt, i) => done({ id: `d${i}`, title: `Done note ${i}`, completedAt })) : [],
      );
      render(<ManagerWindow />);
      await userEvent.click(screen.getByRole("tab", { name: /Completed/ }));
      const rows = await screen.findAllByRole("listitem");
      expect(commands.listNotes).toHaveBeenCalledWith("completed", "");
      expect(rows).toHaveLength(dates.length);
      dates.forEach((ms, i) => {
        expect(within(rows[i]!).getByText(doneDateLabel(ms, NOW))).toBeInTheDocument();
      });
      // The formatter's shape in the machine's locale: time, "yesterday", weekday, date, date with year.
      expect(dates.map((ms) => doneDateLabel(ms, NOW))).toEqual([
        `Done ${new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(NOW - 1000)}`,
        "Done yesterday",
        `Done ${new Intl.DateTimeFormat(undefined, { weekday: "short" }).format(dates[2])}`,
        `Done ${new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" }).format(dates[3])}`,
        `Done ${new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: "numeric" }).format(dates[4])}`,
      ]);
      // This year's dates leave the year out, in any locale's digits or calendar.
      const year = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: "numeric" })
        .formatToParts(dates[3])
        .find((p) => p.type === "year")!.value;
      expect(rows[3]).not.toHaveTextContent(year);
      expect(within(rows[0]!).getByRole("button", { name: "Reopen" })).toBeInTheDocument();
    });

    it("Move to trash on a Completed row trashes the note; it keeps its done date for a restore", async () => {
      vi.mocked(commands.listNotes).mockResolvedValue([done()]);
      render(<ManagerWindow />);
      await userEvent.click(screen.getByRole("tab", { name: /Completed/ }));
      const row = await screen.findByRole("listitem");
      await userEvent.click(within(row).getByRole("button", { name: "Move to trash" }));
      expect(commands.trashNote).toHaveBeenCalledWith("d1");
      expect(commands.setArchived).not.toHaveBeenCalled();
      expect(commands.setNoteCompleted).not.toHaveBeenCalled();
      // The row still offers Reopen next to it.
      expect(within(row).getByRole("button", { name: "Reopen" })).toBeInTheDocument();
    });

    it("Reopen marks the note not done and refreshes", async () => {
      vi.mocked(commands.listNotes).mockResolvedValue([done()]);
      render(<ManagerWindow />);
      await userEvent.click(screen.getByRole("tab", { name: /Completed/ }));
      const reopen = await screen.findByRole("button", { name: "Reopen" });
      const countsBefore = vi.mocked(commands.noteCounts).mock.calls.length;
      await userEvent.click(reopen);
      expect(commands.setNoteCompleted).toHaveBeenCalledWith("d1", false);
      await waitFor(() => expect(vi.mocked(commands.noteCounts).mock.calls.length).toBeGreaterThan(countsBefore));
    });

    it("clicking the row itself does nothing, like an Archived row", async () => {
      vi.mocked(commands.listNotes).mockResolvedValue([done()]);
      render(<ManagerWindow />);
      await userEvent.click(screen.getByRole("tab", { name: /Completed/ }));
      await userEvent.click(await screen.findByRole("listitem"));
      expect(commands.showNote).not.toHaveBeenCalled();
      expect(commands.setNoteCompleted).not.toHaveBeenCalled();
    });

    it("searches within the tab", async () => {
      vi.mocked(commands.listNotes).mockResolvedValue([done({ snippet: "dentist at 5" })]);
      render(<ManagerWindow />);
      await userEvent.click(screen.getByRole("tab", { name: /Completed/ }));
      await userEvent.type(screen.getByRole("searchbox", { name: "Search notes" }), "dentist");
      await waitFor(() => expect(commands.listNotes).toHaveBeenLastCalledWith("completed", "dentist"));
      expect(await screen.findByText("1 note in Completed")).toBeInTheDocument();
    });

    it("says so when nothing is completed", async () => {
      vi.mocked(commands.listNotes).mockResolvedValue([]);
      render(<ManagerWindow />);
      await userEvent.click(screen.getByRole("tab", { name: /Completed/ }));
      expect(await screen.findByText("Nothing completed yet.")).toBeInTheDocument();
    });

    it("locked_rows_show_private_note", async () => {
      vi.mocked(commands.privacyStatus).mockResolvedValue(privacy({ enabled: true, locked: true }));
      vi.mocked(commands.listNotes).mockResolvedValue([
        done({ id: "p1", private: true, locked: true, privateLabel: "", title: "Doctor letter", snippet: "Doctor" }),
      ]);
      render(<ManagerWindow />);
      await userEvent.click(screen.getByRole("tab", { name: /Completed/ }));
      const row = await screen.findByRole("listitem");
      expect(within(row).getByText("Private note")).toBeInTheDocument();
      expect(row).not.toHaveTextContent("Doctor");
    });
  });

  it("shows errors in a banner instead of failing silently", async () => {
    vi.mocked(commands.listNotes).mockRejectedValue(new Error("database is locked"));
    render(<ManagerWindow />);
    expect(await screen.findByRole("alert")).toHaveTextContent("database is locked");
  });

  it("explains when quitting was cancelled because of unsaved text", async () => {
    vi.mocked(commands.listNotes).mockResolvedValue([note()]);
    render(<ManagerWindow />);
    await screen.findByRole("listitem");
    act(() => quitBlocked.handler?.(1));
    expect(await screen.findByRole("alert")).toHaveTextContent("1 note has unsaved text");
  });

  it("opens Settings from the menu", async () => {
    vi.mocked(commands.listNotes).mockResolvedValue([]);
    render(<ManagerWindow />);
    await userEvent.click(screen.getByRole("button", { name: "Menu" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Settings…" }));
    expect(commands.openSettings).toHaveBeenCalled();
  });

  it("hides all notes from the menu", async () => {
    vi.mocked(commands.listNotes).mockResolvedValue([note()]);
    render(<ManagerWindow />);
    await screen.findByRole("listitem");
    await userEvent.click(screen.getByRole("button", { name: "Menu" }));
    expect(screen.queryByRole("menuitem", { name: /Show hidden notes/ })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("menuitem", { name: "Hide all notes" }));
    expect(commands.hideAllNotes).toHaveBeenCalled();
  });

  it("offers to show the hidden notes again, with their number", async () => {
    vi.mocked(commands.listNotes).mockResolvedValue([note({ visible: false })]);
    vi.mocked(commands.hiddenNoteCount).mockResolvedValue(2);
    render(<ManagerWindow />);
    await screen.findByRole("listitem");
    await userEvent.click(screen.getByRole("button", { name: "Menu" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Show hidden notes (2)" }));
    expect(commands.showHiddenNotes).toHaveBeenCalled();
  });

  it("groups long lists by date", async () => {
    const many = Array.from({ length: 14 }, (_, i) => note({ id: `n${i}`, title: `Note ${i}` }));
    vi.mocked(commands.listNotes).mockResolvedValue(many);
    render(<ManagerWindow />);
    expect(await screen.findByText("Today")).toBeInTheDocument();
  });
});

describe("ManagerWindow with private notes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(commands.noteCounts).mockResolvedValue({ active: 2, completed: 0, archived: 0, trash: 0 });
    vi.mocked(commands.startupErrors).mockResolvedValue([]);
    vi.mocked(commands.hiddenNoteCount).mockResolvedValue(0);
    vi.mocked(commands.listReminders).mockResolvedValue([]);
    vi.mocked(commands.privacyStatus).mockResolvedValue(privacy({ enabled: true, locked: true, recovery: "system" }));
  });

  const lockedRow = (over: Partial<NoteSummary> = {}) =>
    note({ id: "p1", private: true, locked: true, privateLabel: "Bank", title: "Bank account 0042 PIN 1234", ...over });

  it("locked_rows_show_label_not_title", async () => {
    vi.mocked(commands.listNotes).mockResolvedValue([
      lockedRow({ snippet: "PIN 1234" }),
      lockedRow({ id: "p2", privateLabel: "", title: "Doctor letter" }),
    ]);
    const { container } = render(<ManagerWindow />);
    const rows = await screen.findAllByRole("listitem");
    expect(within(rows[0]!).getByText("Bank")).toBeInTheDocument();
    expect(within(rows[0]!).getByRole("img", { name: "Private" })).toBeInTheDocument();
    expect(within(rows[1]!).getByText("Private note")).toBeInTheDocument();
    expect(container.textContent).not.toContain("0042");
    expect(container.textContent).not.toContain("1234");
    expect(container.textContent).not.toContain("Doctor");

    // Opens the note, which asks for the PIN itself (D13).
    await userEvent.click(rows[0]!);
    expect(commands.showNote).toHaveBeenCalledWith("p1");
  });

  it("marks unlocked private notes with the lock and shows their title", async () => {
    vi.mocked(commands.privacyStatus).mockResolvedValue(privacy({ enabled: true, recovery: "system" }));
    vi.mocked(commands.listNotes).mockResolvedValue([note({ private: true, privateLabel: "Bank" }), note({ id: "n2", title: "Plain" })]);
    render(<ManagerWindow />);
    const rows = await screen.findAllByRole("listitem");
    expect(within(rows[0]!).getByText("Weekend errands")).toBeInTheDocument();
    expect(within(rows[0]!).getByRole("img", { name: "Private" })).toBeInTheDocument();
    expect(within(rows[1]!).queryByRole("img", { name: "Private" })).toBeNull();
  });

  it("keeps locked rows to their label in compact, grouped lists too", async () => {
    const many = Array.from({ length: 13 }, (_, i) => note({ id: `n${i}`, title: `Note ${i}` }));
    vi.mocked(commands.listNotes).mockResolvedValue([lockedRow(), ...many]);
    const { container } = render(<ManagerWindow />);
    expect(await screen.findByText("Bank")).toBeInTheDocument();
    expect(container.textContent).not.toContain("0042");
  });

  it("lock_now_in_menu_only_when_enabled", async () => {
    vi.mocked(commands.listNotes).mockResolvedValue([]);
    vi.mocked(commands.privacyStatus).mockResolvedValue(privacy({ enabled: false }));
    const { unmount } = render(<ManagerWindow />);
    await waitFor(() => expect(commands.privacyStatus).toHaveBeenCalled());
    await userEvent.click(screen.getByRole("button", { name: "Menu" }));
    expect(screen.queryByRole("menuitem", { name: "Lock now" })).toBeNull();
    unmount();

    // A PIN, but already locked: nothing to lock.
    vi.mocked(commands.privacyStatus).mockResolvedValue(privacy({ enabled: true, locked: true }));
    const second = render(<ManagerWindow />);
    await waitFor(() => expect(commands.privacyStatus).toHaveBeenCalledTimes(2));
    await userEvent.click(screen.getByRole("button", { name: "Menu" }));
    expect(screen.queryByRole("menuitem", { name: "Lock now" })).toBeNull();
    second.unmount();

    vi.mocked(commands.privacyStatus).mockResolvedValue(privacy({ enabled: true, locked: false }));
    render(<ManagerWindow />);
    await waitFor(() => expect(commands.privacyStatus).toHaveBeenCalledTimes(3));
    await userEvent.click(screen.getByRole("button", { name: "Menu" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Lock now" }));
    expect(commands.lockNow).toHaveBeenCalled();
  });

  it("reloads the lock state when it changes", async () => {
    vi.mocked(commands.listNotes).mockResolvedValue([lockedRow()]);
    render(<ManagerWindow />);
    await screen.findByText("Bank");
    vi.mocked(commands.privacyStatus).mockResolvedValue(privacy({ enabled: true, locked: false }));
    vi.mocked(commands.listNotes).mockResolvedValue([note({ id: "p1", private: true, privateLabel: "Bank", title: "Bank account" })]);
    await act(async () => privacyChanged.handler?.({ locked: false }));
    expect(await screen.findByText("Bank account")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Menu" }));
    expect(screen.getByRole("menuitem", { name: "Lock now" })).toBeInTheDocument();
  });

  it("reset_banner_needs_acknowledging", async () => {
    vi.mocked(commands.listNotes).mockResolvedValue([]);
    const resetAt = Date.UTC(2026, 10, 1, 9, 30);
    vi.mocked(commands.privacyStatus).mockResolvedValue(privacy({ resetAt }));
    render(<ManagerWindow />);
    const banner = await screen.findByRole("alert");
    // In the machine's locale (digits and calendar vary: ٢٠٢٦ in Arabic, 2569 in Thai).
    const when = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(resetAt);
    expect(banner).toHaveTextContent(`The PIN was reset on ${when}`);
    expect(banner).toHaveTextContent("choose a new PIN in Settings → Privacy");

    vi.mocked(commands.privacyStatus).mockResolvedValue(privacy({ resetAt: null }));
    await userEvent.click(within(banner).getByRole("button", { name: "OK" }));
    expect(commands.acknowledgePinReset).toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });

  it("explains why a locked private note cannot be deleted for good", async () => {
    vi.mocked(commands.listNotes).mockResolvedValue([lockedRow({ deletedAt: Date.now() })]);
    vi.mocked(commands.purgeNote).mockRejectedValueOnce(new CommandError("private_locked", "private notes are locked"));
    render(<ManagerWindow />);
    await userEvent.click(screen.getByRole("tab", { name: /Trash/ }));
    await userEvent.click(await screen.findByRole("button", { name: "Delete permanently" }));
    expect(screen.getByRole("listitem")).toHaveTextContent("Bank");
    await userEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(commands.purgeNote).toHaveBeenCalledWith("p1");
    expect(await screen.findByRole("alert")).toHaveTextContent("Unlock private notes first.");
  });
});

const reminder = (over: Partial<ReminderListRow> = {}): ReminderListRow => ({
  noteId: "n1",
  title: "Stand-up notes",
  color: "#cfe8ff",
  repeat: "none",
  dueAt: new Date(2026, 10, 4, 23, 0).getTime(),
  overdue: false,
  locked: false,
  archived: false,
  ...over,
});
const at = (d: number, h: number, m = 0) => new Date(2026, 10, d, h, m).getTime();

describe("ManagerWindow Reminders tab (R2)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Wed 4 Nov 2026, 22:30 local. Only the clock is faked, so timers and user events run as usual.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 10, 4, 22, 30));
    vi.mocked(commands.privacyStatus).mockResolvedValue(privacy());
    vi.mocked(commands.noteCounts).mockResolvedValue({ active: 1, completed: 0, archived: 0, trash: 0 });
    vi.mocked(commands.startupErrors).mockResolvedValue([]);
    vi.mocked(commands.hiddenNoteCount).mockResolvedValue(0);
    vi.mocked(commands.listNotes).mockResolvedValue([note()]);
    vi.mocked(commands.listReminders).mockResolvedValue([]);
  });
  afterEach(() => vi.useRealTimers());

  const openTab = async () => {
    render(<ManagerWindow />);
    await userEvent.click(screen.getByRole("tab", { name: /Reminders/ }));
  };

  it("puts the tab between Completed and Archived, counting the reminders", async () => {
    vi.mocked(commands.listReminders).mockResolvedValue([reminder(), reminder({ noteId: "n2" }), reminder({ noteId: "n3" })]);
    render(<ManagerWindow />);
    await waitFor(() => expect(screen.getByRole("tab", { name: /Reminders/ })).toHaveTextContent("3"));
    expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual(["Active1", "Completed", "Reminders3", "Archived", "Trash"]);
    expect(commands.listReminders).toHaveBeenCalledWith("");
  });

  it("has no count when there are no reminders", async () => {
    render(<ManagerWindow />);
    await waitFor(() => expect(screen.getByRole("tab", { name: /Active/ })).toHaveTextContent("1"));
    expect(screen.getByRole("tab", { name: "Reminders" })).toBeInTheDocument();
  });

  it("groups the rows across midnight and puts overdue first in Today", async () => {
    vi.mocked(commands.listReminders).mockResolvedValue([
      reminder({ noteId: "o", title: "Call back", overdue: true, dueAt: at(4, 9, 30) }),
      reminder({ noteId: "t", title: "Stand-up notes", repeat: "weekdays", dueAt: at(4, 23, 0) }),
      reminder({ noteId: "m", title: "Bike repair", dueAt: at(5, 0, 15) }),
      reminder({ noteId: "l", title: "Reading list", repeat: "monthly", dueAt: at(12, 9, 0) }),
      reminder({ noteId: "y", title: "Passport renewal", dueAt: new Date(2027, 0, 15, 9, 0).getTime() }),
    ]);
    await openTab();
    const rows = await screen.findAllByRole("listitem");
    expect(rows.map((r) => r.textContent)).toEqual([
      "Call backOverdue · 09:30",
      "Stand-up notesWeekdays23:00",
      "Bike repair00:15",
      "Reading listMonthly12 Nov",
      "Passport renewal15 Jan 2027",
    ]);
    const labels = [...document.querySelectorAll(".dn-group-label")].map((l) => l.textContent);
    expect(labels).toEqual(["Today", "Tomorrow", "Later"]);
  });

  it("shows what the command returns for a locked note, never a title", async () => {
    vi.mocked(commands.listReminders).mockResolvedValue([
      reminder({ noteId: "p", title: "Private note", locked: true, color: "#ffd6e0" }),
    ]);
    const { container } = render(<ManagerWindow />);
    await userEvent.click(screen.getByRole("tab", { name: /Reminders/ }));
    expect(await screen.findByText("Private note")).toBeInTheDocument();
    expect(container.textContent).not.toContain("Stand-up");
  });

  it("opens the note when its row is clicked", async () => {
    vi.mocked(commands.listReminders).mockResolvedValue([reminder({ noteId: "n7" })]);
    await openTab();
    await userEvent.click(await screen.findByRole("button", { name: /Stand-up notes/ }));
    expect(commands.showNote).toHaveBeenCalledWith("n7");
  });

  it("shows an archived note's row in the Archived tab instead of opening it (R17)", async () => {
    vi.mocked(commands.listReminders).mockImplementation(async (q) =>
      q === "" ? [reminder({ noteId: "n7", archived: true }), reminder({ noteId: "n8", title: "Bike repair" })] : [reminder({ noteId: "n7", archived: true })],
    );
    await openTab();
    await userEvent.type(screen.getByRole("searchbox", { name: "Search notes" }), "stand");
    await waitFor(() => expect(screen.getAllByRole("listitem")).toHaveLength(1));
    await userEvent.click(screen.getByRole("button", { name: /Stand-up notes/ }));
    await waitFor(() => expect(screen.getByRole("tab", { name: /Archived/ })).toHaveAttribute("aria-selected", "true"));
    expect(screen.getByRole("searchbox", { name: "Search notes" })).toHaveValue("");
    await waitFor(() => expect(commands.listNotes).toHaveBeenCalledWith("archived", ""));
    expect(commands.showNote).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("keeps the notes when the reminders cannot be read", async () => {
    vi.mocked(commands.listReminders).mockResolvedValueOnce([reminder(), reminder({ noteId: "n2" })]);
    render(<ManagerWindow />);
    await waitFor(() => expect(screen.getByRole("tab", { name: /Reminders/ })).toHaveTextContent("2"));
    vi.mocked(commands.listReminders).mockRejectedValue(new Error("database is locked"));
    vi.mocked(commands.listNotes).mockResolvedValue([note(), note({ id: "n2", title: "Bike repair" })]);
    vi.mocked(commands.noteCounts).mockResolvedValue({ active: 2, completed: 0, archived: 0, trash: 0 });
    await act(async () => remindersChanged.handler?.({ noteId: null }));
    await waitFor(() => expect(screen.getByText("Bike repair")).toBeInTheDocument());
    expect(screen.getByText("Weekend errands")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /Active/ })).toHaveTextContent("2");
    expect(screen.getByRole("tab", { name: /Reminders/ })).toHaveTextContent("2");
    expect(screen.queryByRole("alert")).toBeNull();

    // On the Reminders tab itself the failure is said.
    await userEvent.click(screen.getByRole("tab", { name: /Reminders/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent("database is locked");
  });

  it("shows a refusal when the note cannot be opened", async () => {
    vi.mocked(commands.listReminders).mockResolvedValue([reminder({ noteId: "n7" })]);
    vi.mocked(commands.showNote).mockRejectedValueOnce(new Error("restore or unarchive the note before showing it"));
    await openTab();
    await userEvent.click(await screen.findByRole("button", { name: /Stand-up notes/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent("restore or unarchive");
  });

  it("filters with the search box but keeps the count of all reminders", async () => {
    vi.mocked(commands.listReminders).mockImplementation(async (q) =>
      q === "" ? [reminder(), reminder({ noteId: "n2", title: "Bike repair" })] : [reminder({ noteId: "n2", title: "Bike repair" })],
    );
    await openTab();
    await userEvent.type(screen.getByRole("searchbox", { name: "Search notes" }), "bike");
    await waitFor(() => expect(commands.listReminders).toHaveBeenCalledWith("bike"));
    await waitFor(() => expect(screen.getAllByRole("listitem")).toHaveLength(1));
    expect(screen.getByRole("tab", { name: /Reminders/ })).toHaveTextContent("2");
    expect(commands.listNotes).not.toHaveBeenCalledWith("reminders", expect.anything());
  });

  it("says so when there are no reminders", async () => {
    await openTab();
    expect(await screen.findByText("No reminders.")).toBeInTheDocument();
  });

  it("says so when a search finds no reminders", async () => {
    await openTab();
    await userEvent.type(screen.getByRole("searchbox", { name: "Search notes" }), "zzz");
    expect(await screen.findByText("No reminders match your search")).toBeInTheDocument();
  });

  it("reloads when reminders change", async () => {
    await openTab();
    await screen.findByText("No reminders.");
    vi.mocked(commands.listReminders).mockResolvedValue([reminder({ title: "Fresh one" })]);
    await act(async () => remindersChanged.handler?.({ noteId: "n1" }));
    expect(await screen.findByText("Fresh one")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /Reminders/ })).toHaveTextContent("1");
  });

  it("reloads every minute while the tab is shown, so the groups follow the clock", async () => {
    vi.useRealTimers();
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    vi.setSystemTime(new Date(2026, 10, 4, 23, 59));
    vi.mocked(commands.listReminders).mockResolvedValue([reminder({ title: "Bike repair", dueAt: at(5, 9, 0) })]);
    await openTab();
    await screen.findByText("Tomorrow");
    const calls = vi.mocked(commands.listReminders).mock.calls.length;
    await act(async () => {
      vi.setSystemTime(new Date(2026, 10, 5, 0, 0, 30));
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(vi.mocked(commands.listReminders).mock.calls.length).toBeGreaterThan(calls);
    await waitFor(() => expect(screen.getByText("Today")).toBeInTheDocument());
    expect(screen.queryByText("Tomorrow")).toBeNull();
  });
});

describe("highlight", () => {
  it("marks the first case-insensitive match", () => {
    const { container } = render(<p>{highlight("Ride the Bike home", "bike")}</p>);
    expect(container.querySelector("mark")).toHaveTextContent("Bike");
    expect(container).toHaveTextContent("Ride the Bike home");
  });
});
