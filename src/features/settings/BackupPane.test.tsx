import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("../../ipc/commands", () => ({
  commands: {
    exportBackup: vi.fn(),
    chooseBackup: vi.fn(),
    cancelRestore: vi.fn().mockResolvedValue(undefined),
    restoreBackup: vi.fn(),
  },
}));

import { commands } from "../../ipc/commands";
import { BackupPane } from "./BackupPane";

describe("BackupPane", () => {
  beforeEach(() => vi.clearAllMocks());

  it("shows when the last backup was made", () => {
    render(<BackupPane lastBackupAt={null} onExported={vi.fn()} />);
    expect(screen.getByText("Last backup: never")).toBeInTheDocument();
  });

  it("exports and reports where the file was saved", async () => {
    const onExported = vi.fn();
    vi.mocked(commands.exportBackup).mockResolvedValue({
      path: "/home/me/desknotes-2026-11-01.json",
      count: 3,
      skipped: 0,
      exportedAt: 123,
    });
    render(<BackupPane lastBackupAt={null} onExported={onExported} />);
    await userEvent.click(screen.getByRole("button", { name: /Export backup/ }));
    expect(await screen.findByRole("status")).toHaveTextContent("3 notes in /home/me/desknotes-2026-11-01.json");
    expect(onExported).toHaveBeenCalledWith(123);
  });

  it("does nothing when the save dialog is cancelled", async () => {
    vi.mocked(commands.exportBackup).mockResolvedValue(null);
    render(<BackupPane lastBackupAt={null} onExported={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: /Export backup/ }));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("explains why an export was refused", async () => {
    vi.mocked(commands.exportBackup).mockRejectedValue(new Error("1 note has unsaved text."));
    render(<BackupPane lastBackupAt={null} onExported={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: /Export backup/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent("unsaved text");
  });

  it("asks before replacing notes, with Cancel focused, and can be cancelled", async () => {
    vi.mocked(commands.chooseBackup).mockResolvedValue({
      fileName: "desknotes-2026-10-24.json",
      backupCount: 27,
      currentCount: 32,
      exportedAt: 1,
    });
    render(<BackupPane lastBackupAt={null} onExported={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: /Restore from backup/ }));
    const dialog = await screen.findByRole("alertdialog", { name: "Restore this backup?" });
    expect(dialog).toHaveTextContent("All 32 current notes");
    expect(dialog).toHaveTextContent("27 notes in desknotes-2026-10-24.json");
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(commands.cancelRestore).toHaveBeenCalled();
    expect(commands.restoreBackup).not.toHaveBeenCalled();
  });

  it("restores after confirmation and says where the previous notes went", async () => {
    vi.mocked(commands.chooseBackup).mockResolvedValue({
      fileName: "b.json",
      backupCount: 2,
      currentCount: 1,
      exportedAt: 1,
    });
    vi.mocked(commands.restoreBackup).mockResolvedValue({ restored: 2, safetyCopy: "/data/backups/pre-restore-1.db" });
    render(<BackupPane lastBackupAt={null} onExported={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: /Restore from backup/ }));
    await userEvent.click(await screen.findByRole("button", { name: "Replace notes" }));
    expect(commands.restoreBackup).toHaveBeenCalled();
    expect(await screen.findByRole("status")).toHaveTextContent("Restored 2 notes");
    expect(screen.getByRole("status")).toHaveTextContent("/data/backups/pre-restore-1.db");
  });

  it("shows why a file cannot be restored and changes nothing", async () => {
    vi.mocked(commands.chooseBackup).mockRejectedValue(new Error("this is not a DeskNotes backup file"));
    render(<BackupPane lastBackupAt={null} onExported={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: /Restore from backup/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent("not a DeskNotes backup");
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });
});
