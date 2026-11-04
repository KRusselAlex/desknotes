//! Export and restore of whole-collection backups (see crate::backup).

use std::path::Path;

use rusqlite::params;

use super::Database;
use super::notes::appearance_json;
use crate::backup::{BACKUP_FORMAT, BACKUP_VERSION, Backup, BackupNote, BackupReminder};
use crate::error::CoreResult;
use crate::now_ms;
use crate::validation::{derive_search_text, derive_title, parse_appearance};

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

    /// Every note, for a backup file. Refused while the privacy lock is in
    /// effect and any private note exists (design §4.4, D12).
    pub fn export_backup(&self, app_version: &str) -> CoreResult<Export> {
        self.refuse_if_any_private_locked()?;
        // A reminder row that cannot be read back is left out, as if the note had none.
        let mut reminders: std::collections::HashMap<String, BackupReminder> = self
            .all_reminders()?
            .into_iter()
            .map(|r| {
                let backup = BackupReminder {
                    local_date: r.rule.local_date.format("%Y-%m-%d").to_string(),
                    local_time: r.rule.local_time.format("%H:%M").to_string(),
                    repeat: r.rule.repeat.as_str().to_string(),
                    due_at: r.due_at,
                    snoozed_until: r.snoozed_until,
                    fired_at: r.fired_at,
                };
                (r.note_id, backup)
            })
            .collect();
        let mut stmt = self.conn.prepare(
            "SELECT n.id, n.content_json, n.color, n.created_at, n.updated_at, n.archived_at,
                    n.deleted_at, n.edit_locked, w.x, w.y, w.width, w.height, w.visible,
                    w.always_on_top, w.collapsed, n.private, n.private_label, n.appearance
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
                    private: r.get(15)?,
                    private_label: r.get(16)?,
                    // Same leniency as reading a note: damaged text means defaults.
                    appearance: parse_appearance(&r.get::<_, String>(17)?).unwrap_or_default(),
                    reminder: None,
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
                    note.reminder = reminders.remove(&note.id);
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
    /// it either fully happens or leaves the notes untouched. Refused, before
    /// anything is written, while the privacy lock is in effect and any private
    /// note exists (design D12).
    pub fn restore_backup(
        &self,
        backup: &Backup,
        safety_dir: &Path,
    ) -> CoreResult<std::path::PathBuf> {
        self.refuse_if_any_private_locked()?;
        let copy = safety_dir.join(format!("pre-restore-{}.db", now_ms()));
        self.backup_to(&copy)?;
        let tx = self.conn.unchecked_transaction()?;
        tx.execute("DELETE FROM notes", [])?; // note_windows and reminders go with ON DELETE CASCADE
        for n in &backup.notes {
            tx.execute(
                "INSERT INTO notes (id, title, content_json, search_text, color, created_at,
                                    updated_at, archived_at, deleted_at, edit_locked, private,
                                    private_label, appearance)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
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
                    n.edit_locked,
                    n.private,
                    n.private_label,
                    appearance_json(&n.appearance)?
                ],
            )?;
            let w = &n.window;
            tx.execute(
                "INSERT INTO note_windows (note_id, x, y, width, height, visible, always_on_top, collapsed)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![n.id, w.x, w.y, w.width, w.height, w.visible, w.always_on_top, w.collapsed],
            )?;
            if let Some(r) = &n.reminder {
                tx.execute(
                    "INSERT INTO reminders (note_id, local_date, local_time, repeat, due_at,
                                            snoozed_until, fired_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                    params![
                        n.id,
                        r.local_date,
                        r.local_time,
                        r.repeat,
                        r.due_at,
                        r.snoozed_until,
                        r.fired_at
                    ],
                )?;
            }
        }
        tx.commit()?;
        // Notes kept open across a lock belonged to the replaced collection.
        self.kept_open.borrow_mut().clear();
        Ok(copy)
    }
}

#[cfg(test)]
mod tests {
    use crate::backup::parse_backup;
    use crate::model::{Appearance, TextDirection};
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
    fn version_2_round_trip_keeps_private_notes_private() {
        let dir = tempfile::tempdir().unwrap();
        let src = Database::open_in_memory().unwrap();
        let (a, b, c) = sample(&src);
        src.set_private(&a, true, "Bank").unwrap();
        src.set_private(&c, true, "").unwrap();
        // Not private any more, but the label is kept for next time.
        src.set_private(&b, true, "Diary").unwrap();
        src.set_private(&b, false, "Diary").unwrap();
        let export = src.export_backup("0.2.0").unwrap();
        assert_eq!(export.backup.version, crate::backup::BACKUP_VERSION);
        let text = serde_json::to_string(&export.backup).unwrap();

        let dst = Database::open(&dir.path().join("d.db"), dir.path()).unwrap();
        dst.restore_backup(&parse_backup(&text).unwrap(), &dir.path().join("backups"))
            .unwrap();
        for id in [&a, &b, &c] {
            assert_eq!(dst.get_note(id).unwrap(), src.get_note(id).unwrap());
        }
        let restored = dst.get_note(&a).unwrap();
        assert!(restored.private);
        assert_eq!(restored.private_label, "Bank");
        assert!(dst.get_note(&c).unwrap().private);
        let not_private = dst.get_note(&b).unwrap();
        assert!(!not_private.private);
        assert_eq!(not_private.private_label, "Diary");

        // The restored private note is withheld once a PIN exists and the lock is on.
        dst.set_new_pin("482913").unwrap();
        dst.set_privacy_locked(true, &[]);
        assert!(dst.get_note(&a).unwrap().locked);
        assert!(
            dst.list_notes(NoteFilter::Active, Some("groceries"))
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn version_3_round_trip_keeps_appearance() {
        let dir = tempfile::tempdir().unwrap();
        let src = Database::open_in_memory().unwrap();
        let (a, b, c) = sample(&src);
        let styled = Appearance {
            font: Some("Lora".into()),
            font_size: Some(20),
            text_color: Some("#1d4f91".into()),
            line_spacing: Some(150),
            direction: Some(TextDirection::Rtl),
            opacity: Some(80),
        };
        src.set_appearance(&a, &styled).unwrap();
        // A private note keeps its styling in a backup too.
        src.set_private(&c, true, "").unwrap();
        src.set_appearance(
            &c,
            &Appearance {
                opacity: Some(85),
                ..Default::default()
            },
        )
        .unwrap();
        let export = src.export_backup("0.3.0").unwrap();
        assert_eq!(export.backup.version, crate::backup::BACKUP_VERSION);
        let text = serde_json::to_string(&export.backup).unwrap();

        let dst = Database::open(&dir.path().join("d.db"), dir.path()).unwrap();
        dst.restore_backup(&parse_backup(&text).unwrap(), &dir.path().join("backups"))
            .unwrap();
        assert_eq!(dst.get_note(&a).unwrap().appearance, styled);
        assert_eq!(dst.get_note(&c).unwrap().appearance.opacity, Some(85));
        assert_eq!(dst.get_note(&b).unwrap().appearance, Appearance::default());
        for id in [&a, &b, &c] {
            assert_eq!(dst.get_note(id).unwrap(), src.get_note(id).unwrap());
        }
    }

    #[test]
    fn version_4_round_trip_keeps_reminders() {
        use chrono_tz::Europe::Paris;

        use crate::reminders::validate_rule;

        let dir = tempfile::tempdir().unwrap();
        let src = Database::open_in_memory().unwrap();
        let (a, b, c) = sample(&src);
        let now = chrono::Utc::now();
        let rule = |d: &str, t: &str, r: &str| validate_rule(d, t, r).unwrap();
        let far = (now + chrono::TimeDelta::days(3))
            .format("%Y-%m-%d")
            .to_string();
        src.set_reminder(&a, rule(&far, "14:05", "weekdays"), now, &Paris)
            .unwrap();
        let before_a = src.reminder(&a).unwrap().unwrap();
        src.mark_fired(&a, before_a.due_at).unwrap();
        src.snooze_reminder(&a, crate::reminders::Snooze::Hour1, now, &Paris)
            .unwrap();
        src.set_reminder(&b, rule(&far, "07:30", "daily"), now, &Paris)
            .unwrap();
        // The trashed note keeps its reminder in a backup too.
        src.restore_note(&c).unwrap();
        src.set_reminder(&c, rule(&far, "23:59", "monthly"), now, &Paris)
            .unwrap();
        src.trash_note(&c).unwrap();
        let export = src.export_backup("0.4.0").unwrap();
        assert_eq!(export.backup.version, 4);
        let text = serde_json::to_string(&export.backup).unwrap();
        assert!(text.contains("\"reminder\":{\"localDate\""), "{text}");

        let dst = Database::open(&dir.path().join("d.db"), dir.path()).unwrap();
        let stray = dst.create_note(None).unwrap().id;
        dst.set_reminder(&stray, rule(&far, "10:00", "none"), now, &Paris)
            .unwrap();
        dst.restore_backup(&parse_backup(&text).unwrap(), &dir.path().join("backups"))
            .unwrap();
        for id in [&a, &b, &c] {
            assert_eq!(dst.reminder(id).unwrap(), src.reminder(id).unwrap());
            assert!(dst.reminder(id).unwrap().is_some());
        }
        let restored = dst.reminder(&a).unwrap().unwrap();
        assert!(restored.snoozed_until.is_some() && restored.fired_at.is_some());
        assert_eq!(
            dst.reminder(&stray).unwrap(),
            None,
            "replaced with the backup's notes"
        );

        // A note without a reminder restores without one.
        let plain = Database::open_in_memory().unwrap();
        let p = plain.create_note(None).unwrap().id;
        let text = serde_json::to_string(&plain.export_backup("0.4.0").unwrap().backup).unwrap();
        dst.restore_backup(&parse_backup(&text).unwrap(), &dir.path().join("backups"))
            .unwrap();
        assert_eq!(dst.reminder(&p).unwrap(), None);
    }

    #[test]
    fn export_leaves_out_a_damaged_reminder_row() {
        let db = Database::open_in_memory().unwrap();
        let id = db.create_note(None).unwrap().id;
        db.conn
            .execute(
                "INSERT INTO reminders VALUES (?1, 'nope', '14:00', 'none', 1793797200000, NULL, NULL)",
                [&id],
            )
            .unwrap();
        let export = db.export_backup("0.4.0").unwrap();
        assert_eq!(export.backup.notes.len(), 1);
        assert_eq!(export.backup.notes[0].reminder, None);
    }

    #[test]
    fn version_3_file_restores_with_no_reminders() {
        let dir = tempfile::tempdir().unwrap();
        let id = "2f1c8f0e-6a8b-4c51-9d4e-2b8f5f1a9c3d";
        let v3 = serde_json::json!({
            "format": "desknotes-backup", "version": 3, "appVersion": "0.3.0", "exportedAt": 3,
            "notes": [{
                "id": id,
                "content": {"type":"doc","content":[{"type":"paragraph"}]},
                "color": "#fff4a3", "createdAt": 1, "updatedAt": 2,
                "archivedAt": null, "deletedAt": null, "editLocked": false,
                "private": false, "privateLabel": "", "appearance": {"fontSize": 18},
                "window": {"x": 10.0, "y": 20.0, "width": 300.0, "height": 280.0,
                           "visible": true, "alwaysOnTop": false, "collapsed": false}
            }]
        })
        .to_string();
        let db = Database::open(&dir.path().join("d.db"), dir.path()).unwrap();
        db.restore_backup(&parse_backup(&v3).unwrap(), &dir.path().join("backups"))
            .unwrap();
        assert_eq!(db.get_note(id).unwrap().appearance.font_size, Some(18));
        assert_eq!(db.reminder(id).unwrap(), None);
    }

    #[test]
    fn old_files_restore_notes_with_default_appearance() {
        let dir = tempfile::tempdir().unwrap();
        let id = "2f1c8f0e-6a8b-4c51-9d4e-2b8f5f1a9c3d";
        let v2 = serde_json::json!({
            "format": "desknotes-backup", "version": 2, "appVersion": "0.2.0", "exportedAt": 3,
            "notes": [{
                "id": id,
                "content": {"type":"doc","content":[{"type":"paragraph"}]},
                "color": "#fff4a3", "createdAt": 1, "updatedAt": 2,
                "archivedAt": null, "deletedAt": null, "editLocked": false,
                "private": false, "privateLabel": "",
                "window": {"x": 10.0, "y": 20.0, "width": 300.0, "height": 280.0,
                           "visible": true, "alwaysOnTop": false, "collapsed": false}
            }]
        })
        .to_string();
        let db = Database::open(&dir.path().join("d.db"), dir.path()).unwrap();
        db.restore_backup(&parse_backup(&v2).unwrap(), &dir.path().join("backups"))
            .unwrap();
        assert_eq!(db.get_note(id).unwrap().appearance, Appearance::default());
    }

    #[test]
    fn version_1_file_restores_every_note_as_not_private() {
        let dir = tempfile::tempdir().unwrap();
        let id = "2f1c8f0e-6a8b-4c51-9d4e-2b8f5f1a9c3d";
        let v1 = serde_json::json!({
            "format": "desknotes-backup", "version": 1, "appVersion": "0.1.0", "exportedAt": 3,
            "notes": [{
                "id": id,
                "content": {"type":"doc","content":[{"type":"paragraph","content":[
                    {"type":"text","text":"from version one"}]}]},
                "color": "#fff4a3", "createdAt": 1, "updatedAt": 2,
                "archivedAt": null, "deletedAt": null, "editLocked": true,
                "window": {"x": 10.0, "y": 20.0, "width": 300.0, "height": 280.0,
                           "visible": true, "alwaysOnTop": false, "collapsed": false}
            }]
        })
        .to_string();
        let db = Database::open(&dir.path().join("d.db"), dir.path()).unwrap();
        db.restore_backup(&parse_backup(&v1).unwrap(), &dir.path().join("backups"))
            .unwrap();
        let note = db.get_note(id).unwrap();
        assert_eq!(note.title, "from version one");
        assert!(note.edit_locked);
        assert!(!note.private);
        assert_eq!(note.private_label, "");
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
