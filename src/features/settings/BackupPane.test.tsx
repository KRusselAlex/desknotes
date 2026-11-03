import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("../../ipc/commands", async (importOriginal) => ({
  CommandError: (await importOriginal<typeof import("../../ipc/commands")>()).CommandError,
  commands: {
    exportBackup: vi.fn(),
    chooseBackup: vi.fn(),
    cancelRestore: vi.fn().mockResolvedValue(undefined),
    restoreBackup: vi.fn(),
    unlock: vi.fn(),
    privacyStatus: vi.fn(),
    forgotPinSystem: vi.fn(),
    openSettings: vi.fn().mockResolvedValue(undefined),
  },
}));

import { CommandError, commands } from "../../ipc/commands";
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

  describe("while private notes are locked (R11)", () => {
    const locked = () => new CommandError("private_locked", "private notes are locked");
    const exported = { path: "/home/me/b.json", count: 4, skipped: 0, exportedAt: 9 };

    it("export_while_locked_asks_pin_then_exports", async () => {
      const onExported = vi.fn();
      vi.mocked(commands.exportBackup).mockRejectedValueOnce(locked()).mockResolvedValueOnce(exported);
      vi.mocked(commands.unlock).mockResolvedValue({ kind: "ok" });
      render(<BackupPane lastBackupAt={null} onExported={onExported} />);
      await userEvent.click(screen.getByRole("button", { name: /Export backup/ }));

      const dialog = await screen.findByRole("dialog", { name: "Unlock private notes" });
      expect(dialog).toHaveTextContent("Enter your PIN so the backup includes them.");
      expect(screen.queryByRole("alert")).toBeNull();
      await userEvent.keyboard("246810");

      expect(commands.unlock).toHaveBeenCalledWith("246810");
      expect(await screen.findByRole("status")).toHaveTextContent("4 notes in /home/me/b.json");
      expect(commands.exportBackup).toHaveBeenCalledTimes(2);
      expect(onExported).toHaveBeenCalledWith(9);
      expect(screen.queryByRole("dialog")).toBeNull();
    });

    it("tries once more only: a second refusal is explained", async () => {
      vi.mocked(commands.exportBackup).mockRejectedValue(locked());
      vi.mocked(commands.unlock).mockResolvedValue({ kind: "ok" });
      render(<BackupPane lastBackupAt={null} onExported={vi.fn()} />);
      await userEvent.click(screen.getByRole("button", { name: /Export backup/ }));
      await screen.findByRole("dialog");
      await userEvent.keyboard("246810");
      expect(await screen.findByRole("alert")).toHaveTextContent("Unlock private notes first.");
      expect(commands.exportBackup).toHaveBeenCalledTimes(2);
      expect(screen.queryByRole("dialog")).toBeNull();
    });

    it("a wrong PIN keeps asking; Cancel exports nothing", async () => {
      vi.mocked(commands.exportBackup).mockRejectedValueOnce(locked());
      vi.mocked(commands.unlock).mockResolvedValue({ kind: "wrong", waitSecs: 0 });
      render(<BackupPane lastBackupAt={null} onExported={vi.fn()} />);
      await userEvent.click(screen.getByRole("button", { name: /Export backup/ }));
      await screen.findByRole("dialog");
      await userEvent.keyboard("111111");
      expect(await screen.findByText("Wrong PIN. Try again.")).toBeInTheDocument();
      await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(commands.exportBackup).toHaveBeenCalledTimes(1);
    });

    it("restoring asks for the PIN before choosing the file", async () => {
      vi.mocked(commands.chooseBackup)
        .mockRejectedValueOnce(locked())
        .mockResolvedValueOnce({ fileName: "b.json", backupCount: 2, currentCount: 1, exportedAt: 1 });
      vi.mocked(commands.unlock).mockResolvedValue({ kind: "ok" });
      render(<BackupPane lastBackupAt={null} onExported={vi.fn()} />);
      await userEvent.click(screen.getByRole("button", { name: /Restore from backup/ }));
      expect(await screen.findByRole("dialog", { name: "Unlock private notes" })).toHaveTextContent(
        "Enter your PIN to restore a backup.",
      );
      await userEvent.keyboard("246810");
      expect(await screen.findByRole("alertdialog", { name: "Restore this backup?" })).toBeInTheDocument();
      expect(commands.chooseBackup).toHaveBeenCalledTimes(2);
    });

    it("a restore refused after the file was chosen lets the file go when cancelled", async () => {
      vi.mocked(commands.chooseBackup).mockResolvedValue({ fileName: "b.json", backupCount: 2, currentCount: 1, exportedAt: 1 });
      vi.mocked(commands.restoreBackup).mockRejectedValueOnce(locked());
      render(<BackupPane lastBackupAt={null} onExported={vi.fn()} />);
      await userEvent.click(screen.getByRole("button", { name: /Restore from backup/ }));
      await userEvent.click(await screen.findByRole("button", { name: "Replace notes" }));
      await screen.findByRole("dialog", { name: "Unlock private notes" });
      expect(commands.cancelRestore).not.toHaveBeenCalled();
      await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
      expect(commands.cancelRestore).toHaveBeenCalled();
      expect(commands.restoreBackup).toHaveBeenCalledTimes(1);
    });

    it("Forgot your PIN? leads to the forgotten-PIN screens here, then on to a new PIN", async () => {
      vi.mocked(commands.exportBackup).mockRejectedValueOnce(locked());
      vi.mocked(commands.privacyStatus).mockResolvedValue({
        enabled: true,
        locked: true,
        lockAfterMinutes: 5,
        recovery: "system",
        recoveryMethod: "system",
        systemAvailable: true,
        resetAt: null,
      });
      vi.mocked(commands.forgotPinSystem).mockResolvedValue(true);
      render(<BackupPane lastBackupAt={null} onExported={vi.fn()} />);
      await userEvent.click(screen.getByRole("button", { name: /Export backup/ }));
      await userEvent.click(await screen.findByRole("button", { name: "Forgot your PIN?" }));
      await waitFor(() => expect(commands.openSettings).toHaveBeenCalledWith("privacy-new-pin"));
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expect(commands.exportBackup).toHaveBeenCalledTimes(1);
    });
  });
});
