//! Export and restore of whole-collection backups (see crate::backup).

use std::collections::BTreeSet;
use std::path::Path;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use rusqlite::{OptionalExtension, params};

use super::Database;
use super::images::sync_note_images_in;
use super::notes::appearance_json;
use super::settings::{PURGE_TRASH_ENABLED, PURGE_TRASH_OFF_BY_RESTORE};
use crate::backup::{
    BACKUP_FORMAT, BACKUP_VERSION, Backup, BackupImage, BackupNote, BackupReminder,
    decode_backup_image,
};
use crate::error::{CoreError, CoreResult};
use crate::now_ms;
use crate::validation::{derive_search_text, derive_title, image_ids, parse_appearance};

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
        self.export_backup_with_limit(app_version, crate::backup::MAX_BACKUP_BYTES)
    }

    pub(crate) fn export_backup_with_limit(
        &self,
        app_version: &str,
        max_bytes: usize,
    ) -> CoreResult<Export> {
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
                    w.always_on_top, w.collapsed, n.private, n.private_label, n.appearance,
                    n.completed_at
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
                    completed_at: r.get(18)?,
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
        let mut backup = Backup {
            format: BACKUP_FORMAT.into(),
            version: BACKUP_VERSION,
            app_version: app_version.into(),
            exported_at: now_ms(),
            notes,
            images: Vec::new(),
        };
        self.add_images_to_backup(&mut backup, max_bytes)?;
        Ok(Export { backup, skipped })
    }

    /// The images the exported notes use, each once, in id order. Refuses, before
    /// reading any image bytes, when the written file would be over `max_bytes`.
    fn add_images_to_backup(&self, backup: &mut Backup, max_bytes: usize) -> CoreResult<()> {
        let exported: BTreeSet<&str> = backup.notes.iter().map(|n| n.id.as_str()).collect();
        let mut stmt = self
            .conn
            .prepare("SELECT DISTINCT note_id, image_id FROM note_images")?;
        let ids: BTreeSet<String> = stmt
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
            .collect::<Result<Vec<_>, _>>()?
            .into_iter()
            .filter(|(note_id, _)| exported.contains(note_id.as_str()))
            .map(|(_, image_id)| image_id)
            .collect();

        let mut found = Vec::new();
        for id in ids {
            let meta = self
                .conn
                .query_row(
                    "SELECT mime, width, height, length(bytes) FROM images WHERE id = ?1",
                    [&id],
                    |r| {
                        Ok((
                            r.get::<_, String>(0)?,
                            r.get::<_, u32>(1)?,
                            r.get::<_, u32>(2)?,
                            r.get::<_, i64>(3)?,
                        ))
                    },
                )
                .optional()?;
            // A reference to an image the database no longer holds writes nothing.
            if let Some((mime, width, height, len)) = meta {
                found.push((
                    id,
                    mime,
                    width,
                    height,
                    usize::try_from(len).unwrap_or(usize::MAX),
                ));
            }
        }

        // The app writes the file pretty-printed. Measure it without the image data,
        // then add the data, which is plain base64 (nothing to escape).
        let data_len = found
            .iter()
            .map(|f| f.4.div_ceil(3).saturating_mul(4))
            .fold(0usize, usize::saturating_add);
        backup.images = found
            .into_iter()
            .map(|(id, mime, width, height, _)| BackupImage {
                id,
                mime,
                width,
                height,
                data: String::new(),
            })
            .collect();
        let shell_len = serde_json::to_vec_pretty(&*backup)
            .map_err(|e| CoreError::Validation(e.to_string()))?
            .len();
        if shell_len.saturating_add(data_len) > max_bytes {
            backup.images.clear();
            return Err(CoreError::NotAllowed(
                "This backup would be over 300 MB. Remove some images and try again.".into(),
            ));
        }
        for img in &mut backup.images {
            let bytes: Vec<u8> =
                self.conn
                    .query_row("SELECT bytes FROM images WHERE id = ?1", [&img.id], |r| {
                        r.get(0)
                    })?;
            img.data = STANDARD.encode(bytes);
        }
        Ok(())
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
        // Images first, so recording which notes use them (below) finds them. Only
        // images some note uses are stored; images the file carries for nobody are
        // left out. Others already in the database stay (start-up clean-up removes
        // the unused ones).
        let used: BTreeSet<String> = backup
            .notes
            .iter()
            .flat_map(|n| image_ids(&n.content))
            .collect();
        for img in backup.images.iter().filter(|i| used.contains(&i.id)) {
            // parse_backup checked these; check again for a Backup built another way.
            let bytes = decode_backup_image(img)?;
            tx.execute(
                "INSERT OR IGNORE INTO images (id, mime, width, height, bytes, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![img.id, img.mime, img.width, img.height, bytes, now_ms()],
            )?;
        }
        for n in &backup.notes {
            tx.execute(
                "INSERT INTO notes (id, title, content_json, search_text, color, created_at,
                                    updated_at, archived_at, deleted_at, edit_locked, private,
                                    private_label, appearance, completed_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
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
                    appearance_json(&n.appearance)?,
                    n.completed_at
                ],
            )?;
            sync_note_images_in(&tx, &n.id, &n.content)?;
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
        // A restore brings back notes with their old trash dates, so "Empty old trash"
        // could delete them within the hour: switch it off (keeping its days) and say why.
        // Same transaction, so the notes and the rule can never disagree.
        if self.get_setting(PURGE_TRASH_ENABLED)?.as_deref() == Some("1") {
            tx.execute("DELETE FROM settings WHERE key = ?1", [PURGE_TRASH_ENABLED])?;
            tx.execute(
                "INSERT INTO settings (key, value) VALUES (?1, '1')
                 ON CONFLICT(key) DO UPDATE SET value = '1'",
                [PURGE_TRASH_OFF_BY_RESTORE],
            )?;
        }
        tx.commit()?;
        // Notes kept open across a lock belonged to the replaced collection.
        self.kept_open.borrow_mut().clear();
        Ok(copy)
    }
}

#[cfg(test)]
mod tests {
    use base64::Engine;
    use base64::engine::general_purpose::STANDARD;
    use image::codecs::png::PngEncoder;
    use image::{ExtendedColorType, ImageEncoder, RgbaImage};
    use serde_json::json;

    use crate::backup::{BackupImage, MAX_BACKUP_BYTES, parse_backup};
    use crate::error::CoreError;
    use crate::image_prep::image_id;
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
    fn restore_keeps_image_references() {
        use image::codecs::png::PngEncoder;
        use image::{ExtendedColorType, ImageEncoder, RgbaImage};

        let dir = tempfile::tempdir().unwrap();
        let db = Database::open_in_memory().unwrap();
        let note = db.create_note(None).unwrap();
        let img = RgbaImage::from_pixel(6, 4, image::Rgba([200, 30, 30, 255]));
        let mut png = Vec::new();
        PngEncoder::new(&mut png)
            .write_image(img.as_raw(), 6, 4, ExtendedColorType::Rgba8)
            .unwrap();
        let info = db.add_image(&note.id, &png).unwrap();
        let content = serde_json::json!({"type":"doc","content":[
            {"type":"paragraph","content":[{"type":"text","text":"with a picture"}]},
            {"type":"image","attrs":{"id":info.id,"width":null}}]});
        db.save_content(&note.id, &content.to_string()).unwrap();

        let export = db.export_backup("0.1.0").unwrap();
        let parsed = parse_backup(&serde_json::to_string(&export.backup).unwrap()).unwrap();
        db.restore_backup(&parsed, &dir.path().join("safety"))
            .unwrap();

        assert_eq!(
            db.remove_unused_images().unwrap(),
            0,
            "the restored note still uses its image"
        );
        db.set_new_pin("482913").unwrap();
        db.set_privacy_locked(true, &[]);
        assert!(db.image_for_display(&info.id).unwrap().is_some());
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
        assert_eq!(export.backup.version, crate::backup::BACKUP_VERSION);
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
    fn version_5_round_trip_keeps_the_done_date() {
        let dir = tempfile::tempdir().unwrap();
        let src = Database::open_in_memory().unwrap();
        let (a, b, c) = sample(&src);
        src.set_completed(&a, true, 1_234).unwrap();
        // Archived and trashed done notes keep their date too.
        src.set_completed(&b, true, 2_345).unwrap();
        src.set_completed(&c, true, 3_456).unwrap_err(); // trashed: refused, stays not done
        let export = src.export_backup("0.5.0").unwrap();
        assert_eq!(export.backup.version, crate::backup::BACKUP_VERSION);
        let text = serde_json::to_string(&export.backup).unwrap();
        assert!(text.contains("\"completedAt\":1234"), "{text}");

        let dst = Database::open(&dir.path().join("d.db"), dir.path()).unwrap();
        dst.restore_backup(&parse_backup(&text).unwrap(), &dir.path().join("backups"))
            .unwrap();
        for id in [&a, &b, &c] {
            assert_eq!(dst.get_note(id).unwrap(), src.get_note(id).unwrap());
        }
        assert_eq!(dst.get_note(&a).unwrap().completed_at, Some(1_234));
        assert_eq!(dst.get_note(&b).unwrap().completed_at, Some(2_345));
        assert_eq!(dst.get_note(&c).unwrap().completed_at, None);
        let done = dst.list_notes(NoteFilter::Completed, None).unwrap();
        assert_eq!(done.len(), 1);
        assert_eq!(done[0].id, a);
    }

    #[test]
    fn restore_turns_purge_off_and_keeps_days() {
        use crate::db::automation::Automations;

        let dir = tempfile::tempdir().unwrap();
        let src = Database::open_in_memory().unwrap();
        sample(&src);
        let text = serde_json::to_string(&src.export_backup("0.5.0").unwrap().backup).unwrap();

        let db = Database::open(&dir.path().join("d.db"), dir.path()).unwrap();
        let rules = Automations {
            auto_complete_checklists: true,
            reset_checklists_on_repeat: true,
            archive_done_enabled: true,
            archive_done_days: 14,
            purge_trash_enabled: true,
            purge_trash_days: 45,
            purge_off_by_restore: false,
        };
        db.enable_purge_trash(45).unwrap();
        db.set_automations(&rules).unwrap();
        db.restore_backup(&parse_backup(&text).unwrap(), &dir.path().join("backups"))
            .unwrap();
        let after = db.automations().unwrap();
        assert!(!after.purge_trash_enabled);
        assert_eq!(after.purge_trash_days, 45);
        assert!(after.purge_off_by_restore);
        // The other rules are untouched.
        assert_eq!(
            Automations {
                purge_trash_enabled: true,
                purge_off_by_restore: false,
                ..after
            },
            rules
        );

        // Saving the rules cannot turn it on again, and keeps the note.
        let kept = db
            .set_automations(&Automations {
                purge_trash_enabled: true,
                ..rules.clone()
            })
            .unwrap();
        assert!(!kept.purge_trash_enabled && kept.purge_off_by_restore);

        // Turning it on through its own method clears the note.
        let again = db.enable_purge_trash(45).unwrap();
        assert!(again.purge_trash_enabled && !again.purge_off_by_restore);

        // A restore while the rule is off leaves it as it is: no flag.
        db.set_automations(&Automations {
            purge_trash_enabled: false,
            ..rules
        })
        .unwrap();
        db.restore_backup(&parse_backup(&text).unwrap(), &dir.path().join("backups2"))
            .unwrap();
        let after = db.automations().unwrap();
        assert!(!after.purge_trash_enabled && !after.purge_off_by_restore);
    }

    #[test]
    fn version_4_file_restores_every_note_as_not_done() {
        let dir = tempfile::tempdir().unwrap();
        let id = "2f1c8f0e-6a8b-4c51-9d4e-2b8f5f1a9c3d";
        let v4 = serde_json::json!({
            "format": "desknotes-backup", "version": 4, "appVersion": "0.4.0", "exportedAt": 3,
            "notes": [{
                "id": id,
                "content": {"type":"doc","content":[{"type":"paragraph"}]},
                "color": "#fff4a3", "createdAt": 1, "updatedAt": 2,
                "archivedAt": null, "deletedAt": null, "editLocked": false,
                "private": false, "privateLabel": "", "appearance": {},
                "reminder": null,
                "window": {"x": 10.0, "y": 20.0, "width": 300.0, "height": 280.0,
                           "visible": true, "alwaysOnTop": false, "collapsed": false}
            }]
        })
        .to_string();
        let db = Database::open(&dir.path().join("d.db"), dir.path()).unwrap();
        db.restore_backup(&parse_backup(&v4).unwrap(), &dir.path().join("backups"))
            .unwrap();
        assert_eq!(db.get_note(id).unwrap().completed_at, None);
        assert_eq!(db.list_notes(NoteFilter::Active, None).unwrap().len(), 1);
        assert!(
            db.list_notes(NoteFilter::Completed, None)
                .unwrap()
                .is_empty()
        );
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

    // ---- version 6: images ----

    /// A small PNG; `shade` makes different images.
    fn png(shade: u8) -> Vec<u8> {
        let img = RgbaImage::from_fn(8, 6, |x, y| {
            image::Rgba([shade, x as u8 * 20, y as u8 * 30, 255])
        });
        let mut out = Vec::new();
        PngEncoder::new(&mut out)
            .write_image(img.as_raw(), 8, 6, ExtendedColorType::Rgba8)
            .unwrap();
        out
    }

    fn doc_with(ids: &[&str]) -> serde_json::Value {
        let mut content =
            vec![json!({"type":"paragraph","content":[{"type":"text","text":"pic"}]})];
        for id in ids {
            content.push(json!({"type":"image","attrs":{"id":id,"width":null}}));
        }
        json!({"type":"doc","content":content})
    }

    /// Add a PNG to `db` for `note_id` and return its id.
    fn add_png(db: &Database, note_id: &str, shade: u8) -> String {
        db.add_image(note_id, &png(shade)).unwrap().id
    }

    fn valid_image(bytes: &[u8]) -> serde_json::Value {
        json!({"id": image_id(bytes), "mime": "image/png", "width": 8, "height": 6,
               "data": STANDARD.encode(bytes)})
    }

    const NOTE_ID: &str = "2f1c8f0e-6a8b-4c51-9d4e-2b8f5f1a9c3d";

    /// A version 6 file with one note that uses the given image ids.
    fn file_v6(used: &[&str], images: Vec<serde_json::Value>) -> String {
        json!({"format": "desknotes-backup", "version": 6, "appVersion": "0.6.0", "exportedAt": 3,
               "notes": [{
                   "id": NOTE_ID, "content": doc_with(used), "color": "#FFF4A3",
                   "createdAt": 1, "updatedAt": 2, "archivedAt": null, "deletedAt": null,
                   "editLocked": false,
                   "window": {"x": 10.0, "y": 20.0, "width": 300.0, "height": 280.0,
                              "visible": true, "alwaysOnTop": false, "collapsed": false}}],
               "images": images})
        .to_string()
    }

    #[test]
    fn version_6_round_trip_keeps_images() {
        let dir = tempfile::tempdir().unwrap();
        let src = Database::open_in_memory().unwrap();
        let a = src.create_note(None).unwrap().id;
        let b = src.create_note(None).unwrap().id;
        let img_a = add_png(&src, &a, 10);
        let img_b = add_png(&src, &b, 200);
        src.save_content(&a, &doc_with(&[&img_a]).to_string())
            .unwrap();
        src.save_content(&b, &doc_with(&[&img_b]).to_string())
            .unwrap();
        src.trash_note(&b).unwrap();

        let export = src.export_backup("0.6.0").unwrap();
        assert_eq!(export.backup.images.len(), 2);
        let text = serde_json::to_string(&export.backup).unwrap();

        let dst = Database::open(&dir.path().join("d.db"), dir.path()).unwrap();
        dst.restore_backup(&parse_backup(&text).unwrap(), &dir.path().join("backups"))
            .unwrap();
        for id in [&img_a, &img_b] {
            let from_src = src.image_for_display(id).unwrap().unwrap();
            let from_dst = dst.image_for_display(id).unwrap().unwrap();
            assert_eq!(from_dst, from_src, "same type and bytes");
        }
        assert_eq!(dst.get_note(&a).unwrap(), src.get_note(&a).unwrap());
        assert_eq!(
            dst.remove_unused_images().unwrap(),
            0,
            "both notes, the trashed one too, use their image"
        );
    }

    #[test]
    fn export_includes_only_referenced_images() {
        let db = Database::open_in_memory().unwrap();
        let a = db.create_note(None).unwrap().id;
        let used = add_png(&db, &a, 10);
        let unused = add_png(&db, &a, 99); // pasted, never saved into the note
        db.save_content(&a, &doc_with(&[&used, &used]).to_string())
            .unwrap();
        let images = db.export_backup("0.6.0").unwrap().backup.images;
        assert_eq!(images.len(), 1, "a twice-used image is written once");
        assert_eq!(images[0].id, used);
        assert_ne!(images[0].id, unused);
        assert_eq!(images[0].mime, "image/png");
        assert_eq!((images[0].width, images[0].height), (8, 6));
        assert_eq!(
            STANDARD.decode(&images[0].data).unwrap(),
            db.image_for_display(&used).unwrap().unwrap().1
        );
    }

    #[test]
    fn restore_keeps_a_note_whose_image_is_missing() {
        let dir = tempfile::tempdir().unwrap();
        let missing = image_id(b"not in the file");
        let raw = file_v6(&[&missing], vec![]);
        let dst = Database::open(&dir.path().join("d.db"), dir.path()).unwrap();
        dst.restore_backup(&parse_backup(&raw).unwrap(), &dir.path().join("backups"))
            .unwrap();
        let note = dst.get_note(NOTE_ID).unwrap();
        assert_eq!(note.content["content"][1]["attrs"]["id"], json!(missing));
        assert!(dst.image_for_display(&missing).unwrap().is_none());
    }

    #[test]
    fn restore_skips_images_no_note_uses() {
        let dir = tempfile::tempdir().unwrap();
        let (used, stray) = (png(1), png(2));
        let raw = file_v6(
            &[&image_id(&used)],
            vec![valid_image(&used), valid_image(&stray)],
        );
        let dst = Database::open(&dir.path().join("d.db"), dir.path()).unwrap();
        dst.restore_backup(&parse_backup(&raw).unwrap(), &dir.path().join("backups"))
            .unwrap();
        assert!(dst.image_for_display(&image_id(&used)).unwrap().is_some());
        assert!(dst.image_for_display(&image_id(&stray)).unwrap().is_none());
    }

    #[test]
    fn bad_image_refuses_the_whole_file() {
        let good = png(1);
        let id = image_id(&good);
        let jpeg_header = {
            let mut v = vec![0xff, 0xd8, 0xff, 0xe0];
            v.extend_from_slice(b"padding");
            v
        };
        let mut huge = vec![0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];
        huge.resize(5 * 1024 * 1024 + 1, 0);

        let mut wrong_id = valid_image(&good);
        wrong_id["id"] = json!(image_id(b"something else"));
        let mut bad_mime = valid_image(&good);
        bad_mime["mime"] = json!("image/svg+xml");
        let mut mime_disagrees = valid_image(&good);
        mime_disagrees["mime"] = json!("image/jpeg");
        let mut not_base64 = valid_image(&good);
        not_base64["data"] = json!("this is !! not base64");
        let mut not_an_image = valid_image(&jpeg_header);
        not_an_image["mime"] = json!("image/png");
        let mut zero_size = valid_image(&good);
        zero_size["width"] = json!(0);
        let mut upper_id = valid_image(&good);
        upper_id["id"] = json!(id.to_uppercase());

        let cases = [
            ("does not match", wrong_id),
            ("type", bad_mime),
            ("type", mime_disagrees),
            ("too large", valid_image(&huge)),
            ("base64", not_base64),
            ("type", not_an_image),
            ("size", zero_size),
            ("id", upper_id),
            ("twice", json!(null)), // replaced below by a duplicate pair
        ];
        for (expect, bad) in cases {
            let images = if bad.is_null() {
                vec![valid_image(&good), valid_image(&good)]
            } else {
                vec![bad]
            };
            let err = parse_backup(&file_v6(&[&id], images)).unwrap_err();
            assert!(matches!(err, CoreError::Validation(_)), "{expect}: {err}");
            assert!(
                err.to_string().contains(expect),
                "expected '{expect}' in: {err}"
            );
        }
        // One bad image among good ones still refuses everything.
        let other = png(2);
        let mut bad = valid_image(&other);
        bad["id"] = json!(image_id(b"x"));
        let err = parse_backup(&file_v6(&[&id], vec![valid_image(&good), bad])).unwrap_err();
        assert!(
            err.to_string().contains("image 2"),
            "names the image: {err}"
        );
        // The same file with all images valid is accepted.
        assert!(parse_backup(&file_v6(&[&id], vec![valid_image(&good)])).is_ok());
    }

    #[test]
    fn version_5_file_still_restores() {
        let dir = tempfile::tempdir().unwrap();
        let raw = json!({"format": "desknotes-backup", "version": 5, "appVersion": "0.5.0",
            "exportedAt": 3, "notes": [{
                "id": NOTE_ID, "content": doc_with(&[]), "color": "#FFF4A3",
                "createdAt": 1, "updatedAt": 2, "archivedAt": null, "deletedAt": null,
                "editLocked": false,
                "window": {"x": 10.0, "y": 20.0, "width": 300.0, "height": 280.0,
                           "visible": true, "alwaysOnTop": false, "collapsed": false}}]})
        .to_string();
        assert!(!raw.contains("\"images\""));
        let parsed = parse_backup(&raw).unwrap();
        assert!(parsed.images.is_empty());
        let dst = Database::open(&dir.path().join("d.db"), dir.path()).unwrap();
        dst.restore_backup(&parsed, &dir.path().join("backups"))
            .unwrap();
        assert_eq!(dst.count_all_notes().unwrap(), 1);
    }

    #[test]
    fn export_over_limit_is_refused() {
        let db = Database::open_in_memory().unwrap();
        let a = db.create_note(None).unwrap().id;
        let id = add_png(&db, &a, 10);
        db.save_content(&a, &doc_with(&[&id]).to_string()).unwrap();
        // The file the app writes is the pretty-printed backup.
        let written = serde_json::to_vec_pretty(&db.export_backup("0.6.0").unwrap().backup)
            .unwrap()
            .len();
        assert!(db.export_backup_with_limit("0.6.0", written).is_ok());
        let err = db
            .export_backup_with_limit("0.6.0", written - 1)
            .err()
            .unwrap();
        match err {
            CoreError::NotAllowed(msg) => assert_eq!(
                msg,
                "This backup would be over 300 MB. Remove some images and try again."
            ),
            other => panic!("wrong error: {other}"),
        }
        assert_eq!(MAX_BACKUP_BYTES, 300 * 1024 * 1024);
    }

    #[test]
    fn backup_image_serialises_with_camel_case_keys() {
        let img = BackupImage {
            id: "a".repeat(64),
            mime: "image/png".into(),
            width: 1,
            height: 2,
            data: "AA==".into(),
        };
        let v = serde_json::to_value(&img).unwrap();
        assert_eq!(v["width"], json!(1));
        assert_eq!(v["data"], json!("AA=="));
    }
}
