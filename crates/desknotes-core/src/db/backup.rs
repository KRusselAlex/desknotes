//! Export and restore of whole-collection backups (see crate::backup).

use std::path::Path;

use rusqlite::params;

use super::Database;
use crate::backup::{BACKUP_FORMAT, BACKUP_VERSION, Backup, BackupNote};
use crate::error::CoreResult;
use crate::now_ms;
use crate::validation::{derive_search_text, derive_title};

/// Settings key holding the time of the last successful export (Unix ms).
pub const LAST_BACKUP_AT: &str = "last_backup_at";

/// Result of `export_backup`: the backup, plus notes whose stored content was
/// unreadable and therefore could not be included.
pub struct Export {
    pub backup: Backup,
    pub skipped: Vec<String>,
}

impl Database {
    /// Number of notes of every kind (active, archived, trash).
    pub fn count_all_notes(&self) -> CoreResult<i64> {
        Ok(self
            .conn
            .query_row("SELECT count(*) FROM notes", [], |r| r.get(0))?)
    }

    pub fn export_backup(&self, app_version: &str) -> CoreResult<Export> {
        let mut stmt = self.conn.prepare(
            "SELECT n.id, n.content_json, n.color, n.created_at, n.updated_at, n.archived_at,
                    n.deleted_at, n.edit_locked, w.x, w.y, w.width, w.height, w.visible,
                    w.always_on_top, w.collapsed
             FROM notes n JOIN note_windows w ON w.note_id = n.id
             ORDER BY n.created_at",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                BackupNote {
                    id: r.get(0)?,
                    content: serde_json::Value::Null,
                    color: r.get(2)?,
                    created_at: r.get(3)?,
                    updated_at: r.get(4)?,
                    archived_at: r.get(5)?,
                    deleted_at: r.get(6)?,
                    edit_locked: r.get(7)?,
                    window: crate::model::NoteWindow {
                        x: r.get(8)?,
                        y: r.get(9)?,
                        width: r.get(10)?,
                        height: r.get(11)?,
                        visible: r.get(12)?,
                        always_on_top: r.get(13)?,
                        collapsed: r.get(14)?,
                    },
                },
            ))
        })?;
        let (mut notes, mut skipped) = (Vec::new(), Vec::new());
        for row in rows {
            let (id, raw, mut note) = row?;
            match serde_json::from_str(&raw) {
                Ok(content) => {
                    note.content = content;
                    notes.push(note);
                }
                Err(_) => skipped.push(id),
            }
        }
        Ok(Export {
            backup: Backup {
                format: BACKUP_FORMAT.into(),
                version: BACKUP_VERSION,
                app_version: app_version.into(),
                exported_at: now_ms(),
                notes,
            },
            skipped,
        })
    }

    /// Replace every note with the notes of a validated backup (from
    /// `crate::backup::parse_backup`). A full copy of the current database is
    /// written to `safety_dir` first, and the replacement is one transaction:
    /// it either fully happens or leaves the notes untouched.
    pub fn restore_backup(
        &self,
        backup: &Backup,
        safety_dir: &Path,
    ) -> CoreResult<std::path::PathBuf> {
        let copy = safety_dir.join(format!("pre-restore-{}.db", now_ms()));
        self.backup_to(&copy)?;
        let tx = self.conn.unchecked_transaction()?;
        tx.execute("DELETE FROM notes", [])?; // note_windows rows go with ON DELETE CASCADE
        for n in &backup.notes {
            tx.execute(
                "INSERT INTO notes (id, title, content_json, search_text, color, created_at,
                                    updated_at, archived_at, deleted_at, edit_locked)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                params![
                    n.id,
                    derive_title(&n.content),
                    n.content.to_string(),
                    derive_search_text(&n.content),
                    n.color,
                    n.created_at,
                    n.updated_at,
                    n.archived_at,
                    n.deleted_at,
                    n.edit_locked
                ],
            )?;
            let w = &n.window;
            tx.execute(
                "INSERT INTO note_windows (note_id, x, y, width, height, visible, always_on_top, collapsed)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![n.id, w.x, w.y, w.width, w.height, w.visible, w.always_on_top, w.collapsed],
            )?;
        }
        tx.commit()?;
        Ok(copy)
    }
}

#[cfg(test)]
mod tests {
    use crate::backup::parse_backup;
    use crate::{Database, NoteFilter};

    const FIXTURE: &str = include_str!("../../../../tests/fixtures/rich-doc.json");

    fn sample(db: &Database) -> (String, String, String) {
        let a = db.create_note(Some("#c8f7c5")).unwrap().id;
        db.save_content(&a, FIXTURE).unwrap();
        db.set_window_geometry(&a, Some((40.0, 50.0)), 360.0, 300.0)
            .unwrap();
        db.set_always_on_top(&a, true).unwrap();
        let b = db.create_note(None).unwrap().id;
        db.set_archived(&b, true).unwrap();
        let c = db.create_note(None).unwrap().id;
        db.trash_note(&c).unwrap();
        (a, b, c)
    }

    #[test]
    fn export_then_restore_reproduces_every_note_exactly() {
        let dir = tempfile::tempdir().unwrap();
        let src = Database::open_in_memory().unwrap();
        let (a, b, c) = sample(&src);
        let export = src.export_backup("0.1.0").unwrap();
        assert!(export.skipped.is_empty());
        let text = serde_json::to_string(&export.backup).unwrap();

        let dst = Database::open(&dir.path().join("d.db"), dir.path()).unwrap();
        dst.create_note(None).unwrap(); // something to be replaced
        let parsed = parse_backup(&text).unwrap();
        let copy = dst
            .restore_backup(&parsed, &dir.path().join("backups"))
            .unwrap();
        assert!(copy.exists(), "safety copy written before restoring");

        assert_eq!(dst.count_all_notes().unwrap(), 3);
        for id in [&a, &b, &c] {
            assert_eq!(dst.get_note(id).unwrap(), src.get_note(id).unwrap());
        }
        assert_eq!(dst.list_notes(NoteFilter::Trash, None).unwrap().len(), 1);
        assert_eq!(
            dst.list_notes(NoteFilter::Active, Some("groceries"))
                .unwrap()
                .len(),
            1
        );
    }

    #[test]
    fn unreadable_notes_are_reported_not_hidden() {
        let db = Database::open_in_memory().unwrap();
        let (a, _, _) = sample(&db);
        db.conn
            .execute(
                "UPDATE notes SET content_json = '{oops' WHERE id = ?1",
                [&a],
            )
            .unwrap();
        let export = db.export_backup("0.1.0").unwrap();
        assert_eq!(export.skipped, vec![a]);
        assert_eq!(export.backup.notes.len(), 2);
    }
}
