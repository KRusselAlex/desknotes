import { useEffect, useRef, useState } from "react";
import { Icon } from "../../components/Icon";
import { commands } from "../../ipc/commands";
import type { RestorePreview } from "../../types/note";
import { isLockRefusal, refusalText } from "../privacy/refusal";
import { UnlockDialog } from "../privacy/UnlockDialog";

const dateTime = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

type Notice = { kind: "ok" | "error"; text: string } | null;

/** What was refused because private notes are locked, to try once more after the PIN (R11). */
type Waiting = { step: "export" | "choose" | "replace"; retry: () => Promise<void> };

const UNLOCK_TEXT: Record<Waiting["step"], string> = {
  export: "Private notes are locked. Enter your PIN so the backup includes them.",
  choose: "Private notes are locked. Enter your PIN to restore a backup.",
  replace: "Private notes are locked. Enter your PIN to restore a backup.",
};

/** Backup section of Settings (design S3). */
export function BackupPane({
  lastBackupAt,
  onExported,
}: {
  lastBackupAt: number | null;
  onExported: (at: number) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [preview, setPreview] = useState<RestorePreview | null>(null);
  const [waiting, setWaiting] = useState<Waiting | null>(null);

  /**
   * Runs an export or restore step. While private notes are locked the native side
   * refuses it before any file dialog; then the PIN is asked for here and the step is
   * tried once more (`step` given only on the first try).
   */
  async function run(action: () => Promise<void>, step?: Waiting["step"]) {
    setBusy(true);
    setNotice(null);
    try {
      await action();
    } catch (e) {
      if (step && isLockRefusal(e)) setWaiting({ step, retry: () => run(action) });
      else setNotice({ kind: "error", text: refusalText(e) });
    } finally {
      setBusy(false);
    }
  }

  /** The PIN dialog closed without the retry: a file chosen for restoring is let go. */
  function dropWaiting() {
    if (waiting?.step === "replace") void commands.cancelRestore();
    setWaiting(null);
  }

  const exportNow = () =>
    run(async () => {
      const result = await commands.exportBackup();
      if (!result) return; // cancelled
      onExported(result.exportedAt);
      const skipped = result.skipped
        ? ` ${result.skipped} damaged ${result.skipped === 1 ? "note was" : "notes were"} left out.`
        : "";
      setNotice({
        kind: result.skipped ? "error" : "ok",
        text: `Backup saved: ${result.count} ${result.count === 1 ? "note" : "notes"} in ${result.path}.${skipped}`,
      });
    }, "export");

  const chooseFile = () =>
    run(async () => {
      const p = await commands.chooseBackup();
      if (p) setPreview(p);
    }, "choose");

  const cancel = () => {
    setPreview(null);
    void commands.cancelRestore();
  };

  const replace = () =>
    run(async () => {
      setPreview(null);
      const r = await commands.restoreBackup();
      setNotice({
        kind: "ok",
        text: `Restored ${r.restored} ${r.restored === 1 ? "note" : "notes"}. Your previous notes were saved in ${r.safetyCopy}.`,
      });
    }, "replace");

  return (
    <>
      <h1>Backup</h1>
      <div className="dn-card dn-card-pad">
        <div className="dn-muted">
          Last backup: {lastBackupAt ? dateTime.format(lastBackupAt) : "never"}
        </div>
        <div className="dn-button-row">
          <button type="button" className="dn-btn-accent is-small" disabled={busy} onClick={() => void exportNow()}>
            <Icon name="download" size={15} />
            <span>Export backup…</span>
          </button>
          <button type="button" className="dn-btn-outline is-medium" disabled={busy} onClick={() => void chooseFile()}>
            <Icon name="upload" size={15} />
            Restore from backup…
          </button>
        </div>
        <div className="dn-muted dn-small">
          A backup holds every note, including archived and trashed ones. It is a JSON file you
          can keep anywhere.
        </div>
      </div>
      {notice && (
        <div className={notice.kind === "ok" ? "dn-notice-ok" : "dn-banner-error"} role={notice.kind === "ok" ? "status" : "alert"}>
          <Icon name={notice.kind === "ok" ? "check" : "alert"} size={16} />
          <span>{notice.text}</span>
        </div>
      )}
      {preview && <ConfirmRestore preview={preview} onCancel={cancel} onReplace={() => void replace()} />}
      {waiting && (
        <UnlockDialog
          title="Unlock private notes"
          text={UNLOCK_TEXT[waiting.step]}
          onUnlocked={() => {
            setWaiting(null);
            void waiting.retry();
          }}
          // Settings moves on to choosing a new PIN; the backup can be made after that.
          onProved={dropWaiting}
          onCancel={dropWaiting}
        />
      )}
    </>
  );
}

function ConfirmRestore({
  preview,
  onCancel,
  onReplace,
}: {
  preview: RestorePreview;
  onCancel: () => void;
  onReplace: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => cancelRef.current?.focus(), []);
  const notes = (n: number) => `${n} ${n === 1 ? "note" : "notes"}`;
  return (
    <div className="dn-modal-backdrop" onKeyDown={(e) => e.key === "Escape" && onCancel()}>
      <div className="dn-modal" role="alertdialog" aria-modal="true" aria-labelledby="restore-title" aria-describedby="restore-text">
        <div id="restore-title" className="dn-modal-title">
          Restore this backup?
        </div>
        <div id="restore-text" className="dn-modal-text">
          All {preview.currentCount === 1 ? "1 current note" : `${preview.currentCount} current notes`}, including
          archived and trashed ones, will be replaced by the {notes(preview.backupCount)} in{" "}
          <strong>{preview.fileName}</strong>. A copy of your current notes is saved first. Settings are not
          changed.
        </div>
        <div className="dn-modal-actions">
          <button ref={cancelRef} type="button" className="dn-btn-outline is-large" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="dn-btn-danger is-large" onClick={onReplace}>
            Replace notes
          </button>
        </div>
      </div>
    </div>
  );
}
