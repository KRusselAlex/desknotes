import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { NoteSummary, PrivacyStatus } from "../../types/note";

const quitBlocked: { handler?: (count: number) => void } = {};
const privacyChanged: { handler?: (e: { locked: boolean }) => void } = {};
vi.mock("../../ipc/events", () => ({
  onNotesChanged: () => Promise.resolve(() => undefined),
  onPrivacyChanged: (h: (e: { locked: boolean }) => void) => {
    privacyChanged.handler = h;
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
    startupErrors: vi.fn(),
    createNote: vi.fn().mockResolvedValue({}),
    showNote: vi.fn().mockResolvedValue(undefined),
    hideNote: vi.fn().mockResolvedValue(undefined),
    setArchived: vi.fn().mockResolvedValue(undefined),
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
    vi.mocked(commands.noteCounts).mockResolvedValue({ active: 1, archived: 0, trash: 1 });
    vi.mocked(commands.startupErrors).mockResolvedValue([]);
    vi.mocked(commands.hiddenNoteCount).mockResolvedValue(0);
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
    vi.mocked(commands.noteCounts).mockResolvedValue({ active: 2, archived: 0, trash: 0 });
    vi.mocked(commands.startupErrors).mockResolvedValue([]);
    vi.mocked(commands.hiddenNoteCount).mockResolvedValue(0);
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
    vi.mocked(commands.privacyStatus).mockResolvedValue(privacy({ resetAt: Date.UTC(2026, 10, 1, 9, 30) }));
    render(<ManagerWindow />);
    const banner = await screen.findByRole("alert");
    expect(banner).toHaveTextContent(/The PIN was reset on .*2026/);
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

describe("highlight", () => {
  it("marks the first case-insensitive match", () => {
    const { container } = render(<p>{highlight("Ride the Bike home", "bike")}</p>);
    expect(container.querySelector("mark")).toHaveTextContent("Bike");
    expect(container).toHaveTextContent("Ride the Bike home");
  });
});
