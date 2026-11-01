import { useEffect, useRef, useState } from "react";
import { Icon } from "../../components/Icon";
import { commands } from "../../ipc/commands";
import type { RestorePreview } from "../../types/note";

const dateTime = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

type Notice = { kind: "ok" | "error"; text: string } | null;

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

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setNotice(null);
    try {
      await action();
    } catch (e) {
      setNotice({ kind: "error", text: (e as Error).message });
    } finally {
      setBusy(false);
    }
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
    });

  const chooseFile = () =>
    run(async () => {
      const p = await commands.chooseBackup();
      if (p) setPreview(p);
    });

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
    });

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
