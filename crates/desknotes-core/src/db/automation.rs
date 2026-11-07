//! Automation rules (DES-42): their settings and the data changes they make.
//! Nothing here runs by itself; the shell decides when to call it.

use rusqlite::{Transaction, params};
use serde::{Deserialize, Serialize};

use super::Database;
use super::settings::{
    ARCHIVE_DONE_DAYS, ARCHIVE_DONE_ENABLED, AUTO_COMPLETE_CHECKLISTS, PURGE_TRASH_DAYS,
    PURGE_TRASH_ENABLED, PURGE_TRASH_OFF_BY_RESTORE, RESET_CHECKLISTS_ON_REPEAT,
};
use crate::error::{CoreError, CoreResult};
use crate::now_ms;
use crate::reminders::Repeat;
use crate::validation::untick_all;

pub const ARCHIVE_DONE_DAYS_DEFAULT: u32 = 7;
pub const ARCHIVE_DONE_DAYS_RANGE: std::ops::RangeInclusive<u32> = 1..=90;
pub const PURGE_TRASH_DAYS_DEFAULT: u32 = 30;
pub const PURGE_TRASH_DAYS_RANGE: std::ops::RangeInclusive<u32> = 7..=365;

/// One day in UTC milliseconds. Rules count days this way, never calendar days.
const DAY_MS: i64 = 86_400_000;

/// The cutoff for "more than `days` days ago": `now_ms - days × 86 400 000`.
/// A time strictly before it is old enough for a rule.
pub fn cutoff_ms(now_ms: i64, days: u32) -> i64 {
    now_ms - i64::from(days) * DAY_MS
}

/// The four automation rules and their settings. Every rule is off by default.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Automations {
    /// Rule 1: mark a checklist done when every item is ticked.
    pub auto_complete_checklists: bool,
    /// Rule 2: untick a checklist when its repeating reminder goes off.
    pub reset_checklists_on_repeat: bool,
    /// Rule 3: archive done notes after `archive_done_days`.
    pub archive_done_enabled: bool,
    pub archive_done_days: u32,
    /// Rule 4: delete notes that have been in the trash for `purge_trash_days`.
    pub purge_trash_enabled: bool,
    pub purge_trash_days: u32,
    /// Read-only: a restore switched rule 4 off. Ignored when saving.
    pub purge_off_by_restore: bool,
}

impl Database {
    /// The rule settings. A missing or damaged value falls back to its default
    /// (off, 7 days, 30 days), so a bad stored value never turns a rule on.
    pub fn automations(&self) -> CoreResult<Automations> {
        let flag =
            |key: &str| -> CoreResult<bool> { Ok(self.get_setting(key)?.as_deref() == Some("1")) };
        let days = |key: &str, default: u32, range: &std::ops::RangeInclusive<u32>| {
            self.get_setting(key).map(|raw| {
                raw.and_then(|r| r.parse::<u32>().ok())
                    .filter(|d| range.contains(d))
                    .unwrap_or(default)
            })
        };
        Ok(Automations {
            auto_complete_checklists: flag(AUTO_COMPLETE_CHECKLISTS)?,
            reset_checklists_on_repeat: flag(RESET_CHECKLISTS_ON_REPEAT)?,
            archive_done_enabled: flag(ARCHIVE_DONE_ENABLED)?,
            archive_done_days: days(
                ARCHIVE_DONE_DAYS,
                ARCHIVE_DONE_DAYS_DEFAULT,
                &ARCHIVE_DONE_DAYS_RANGE,
            )?,
            purge_trash_enabled: flag(PURGE_TRASH_ENABLED)?,
            purge_trash_days: days(
                PURGE_TRASH_DAYS,
                PURGE_TRASH_DAYS_DEFAULT,
                &PURGE_TRASH_DAYS_RANGE,
            )?,
            purge_off_by_restore: flag(PURGE_TRASH_OFF_BY_RESTORE)?,
        })
    }

    /// Validate and store all rule settings in one transaction, and return what
    /// is now stored. Out-of-range days are refused (`Validation`, naming the
    /// field) and nothing changes. `purge_off_by_restore` in the input is ignored.
    ///
    /// This never turns rule 4 on: if it is stored off, it stays off whatever the
    /// input says (a window that has not heard of a restore must not switch it back
    /// on). Turning it off and changing its days work. [`Self::enable_purge_trash`]
    /// is the only way on, and Settings asks first.
    pub fn set_automations(&self, a: &Automations) -> CoreResult<Automations> {
        if !ARCHIVE_DONE_DAYS_RANGE.contains(&a.archive_done_days) {
            return Err(CoreError::Validation(format!(
                "archiveDoneDays must be {}–{}",
                ARCHIVE_DONE_DAYS_RANGE.start(),
                ARCHIVE_DONE_DAYS_RANGE.end()
            )));
        }
        if !PURGE_TRASH_DAYS_RANGE.contains(&a.purge_trash_days) {
            return Err(CoreError::Validation(format!(
                "purgeTrashDays must be {}–{}",
                PURGE_TRASH_DAYS_RANGE.start(),
                PURGE_TRASH_DAYS_RANGE.end()
            )));
        }
        let tx = self.conn.unchecked_transaction()?;
        let purge_was_on = self.get_setting(PURGE_TRASH_ENABLED)?.as_deref() == Some("1");
        for (key, on) in [
            (AUTO_COMPLETE_CHECKLISTS, a.auto_complete_checklists),
            (RESET_CHECKLISTS_ON_REPEAT, a.reset_checklists_on_repeat),
            (ARCHIVE_DONE_ENABLED, a.archive_done_enabled),
            (PURGE_TRASH_ENABLED, a.purge_trash_enabled && purge_was_on),
        ] {
            put_flag(&tx, key, on)?;
        }
        for (key, days) in [
            (ARCHIVE_DONE_DAYS, a.archive_done_days),
            (PURGE_TRASH_DAYS, a.purge_trash_days),
        ] {
            tx.execute(
                "INSERT INTO settings (key, value) VALUES (?1, ?2)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                params![key, days.to_string()],
            )?;
        }
        tx.commit()?;
        self.automations()
    }

    /// Turn rule 4 on with `days` (7–365), the one way it is switched on. Out-of-range
    /// days are refused (`Validation`) and nothing changes. Clears the "turned off by
    /// a restore" note. Returns what is now stored.
    pub fn enable_purge_trash(&self, days: u32) -> CoreResult<Automations> {
        if !PURGE_TRASH_DAYS_RANGE.contains(&days) {
            return Err(CoreError::Validation(format!(
                "purgeTrashDays must be {}–{}",
                PURGE_TRASH_DAYS_RANGE.start(),
                PURGE_TRASH_DAYS_RANGE.end()
            )));
        }
        let tx = self.conn.unchecked_transaction()?;
        put_flag(&tx, PURGE_TRASH_ENABLED, true)?;
        put_flag(&tx, PURGE_TRASH_OFF_BY_RESTORE, false)?;
        tx.execute(
            "INSERT INTO settings (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![PURGE_TRASH_DAYS, days.to_string()],
        )?;
        tx.commit()?;
        self.automations()
    }

    /// Rule 3: archive every done note whose `completed_at` is before `cutoff_ms`
    /// and that is not archived or in the trash, as the manager's Archive does.
    /// Private notes the lock withholds are skipped. Returns how many were archived.
    pub fn archive_done_before(&self, cutoff_ms: i64) -> CoreResult<usize> {
        let ids = self.rule_candidates(
            "completed_at < ?1 AND archived_at IS NULL AND deleted_at IS NULL",
            cutoff_ms,
        )?;
        let now = now_ms();
        let tx = self.conn.unchecked_transaction()?;
        for id in &ids {
            tx.execute(
                "UPDATE notes SET archived_at = ?2 WHERE id = ?1",
                params![id, now],
            )?;
            tx.execute(
                "UPDATE note_windows SET visible = 0 WHERE note_id = ?1",
                [id],
            )?;
        }
        tx.commit()?;
        Ok(ids.len())
    }

    /// Rule 4: permanently delete every trashed note deleted before `cutoff_ms`,
    /// as `purge_note` does (reminders and windows go with it). Private notes the
    /// lock withholds are skipped. Returns how many were deleted.
    pub fn purge_trashed_before(&self, cutoff_ms: i64) -> CoreResult<usize> {
        let ids = self.rule_candidates("deleted_at < ?1", cutoff_ms)?;
        let tx = self.conn.unchecked_transaction()?;
        for id in &ids {
            tx.execute(
                "DELETE FROM notes WHERE id = ?1 AND deleted_at IS NOT NULL",
                [id],
            )?;
        }
        tx.commit()?;
        for id in &ids {
            self.release_kept_open(id);
        }
        Ok(ids.len())
    }

    /// How many notes `purge_trashed_before(cutoff_ms)` would delete right now.
    pub fn count_purgeable(&self, cutoff_ms: i64) -> CoreResult<usize> {
        Ok(self.rule_candidates("deleted_at < ?1", cutoff_ms)?.len())
    }

    /// Ids of the notes matching `condition` (which takes the cutoff as `?1`),
    /// without those the privacy lock withholds.
    fn rule_candidates(&self, condition: &str, cutoff_ms: i64) -> CoreResult<Vec<String>> {
        let lock = self.lock_active()?;
        let mut stmt = self
            .conn
            .prepare(&format!("SELECT id, private FROM notes WHERE {condition}"))?;
        let rows = stmt.query_map([cutoff_ms], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, bool>(1)?))
        })?;
        let mut ids = Vec::new();
        for row in rows {
            let (id, private) = row?;
            if !self.withheld(lock, private, &id) {
                ids.push(id);
            }
        }
        Ok(ids)
    }

    /// Untick every checklist item of a note and save it through `save_content`
    /// (title and search text recomputed), in one transaction. Returns false when
    /// no item was ticked. Refused for a withheld note (`PrivateLocked`) and for an
    /// edit-locked one (`NotAllowed`).
    pub fn untick_checklist(&self, note_id: &str) -> CoreResult<bool> {
        self.refuse_if_note_locked(note_id)?;
        let tx = self.conn.unchecked_transaction()?;
        let note = self.get_note(note_id)?;
        if note.edit_locked {
            return Err(CoreError::NotAllowed(
                "this note is locked for editing".into(),
            ));
        }
        let Some(doc) = untick_all(&note.content) else {
            return Ok(false);
        };
        self.save_content(note_id, &doc.to_string())?;
        tx.commit()?;
        Ok(true)
    }

    /// Rule 2: whether the reminder occurrence that just fired (`fired_due`, the
    /// effective due time it fired at) should reset its note's checklist. True only
    /// for the first fire of an occurrence (`fired_due == due_at`, so never a
    /// snooze) of a repeating reminder, with rule 2 on, on a note that is open
    /// (not done, archived, trashed, withheld or edit-locked) with a ticked item.
    pub fn checklist_reset_due(&self, note_id: &str, fired_due: i64) -> CoreResult<bool> {
        if !self.automations()?.reset_checklists_on_repeat {
            return Ok(false);
        }
        let Some(reminder) = self.reminder(note_id)? else {
            return Ok(false);
        };
        if reminder.rule.repeat == Repeat::None || fired_due != reminder.due_at {
            return Ok(false);
        }
        let note = self.get_note(note_id)?;
        if note.locked
            || note.edit_locked
            || note.completed_at.is_some()
            || note.archived_at.is_some()
            || note.deleted_at.is_some()
        {
            return Ok(false);
        }
        Ok(untick_all(&note.content).is_some())
    }
}

/// A switch: `"1"` when on, no row when off.
fn put_flag(tx: &Transaction<'_>, key: &str, on: bool) -> CoreResult<()> {
    if on {
        tx.execute(
            "INSERT INTO settings (key, value) VALUES (?1, '1')
             ON CONFLICT(key) DO UPDATE SET value = '1'",
            [key],
        )?;
    } else {
        tx.execute("DELETE FROM settings WHERE key = ?1", [key])?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use chrono::Utc;
    use serde_json::{Value, json};

    use super::*;
    use crate::db::privacy::PIN_HASH;
    use crate::reminders::{Snooze, validate_rule};
    use crate::validation::untick_all;

    fn db() -> Database {
        Database::open_in_memory().unwrap()
    }

    fn on() -> Automations {
        Automations {
            auto_complete_checklists: true,
            reset_checklists_on_repeat: true,
            archive_done_enabled: true,
            archive_done_days: 7,
            purge_trash_enabled: true,
            purge_trash_days: 30,
            purge_off_by_restore: false,
        }
    }

    fn task(text: &str, checked: bool) -> Value {
        json!({"type":"taskItem","attrs":{"checked":checked},"content":[
            {"type":"paragraph","content":[{"type":"text","text":text}]}]})
    }

    fn checklist(items: Vec<Value>) -> Value {
        json!({"type":"doc","content":[
            {"type":"paragraph","content":[{"type":"text","text":"Morning Routine"}]},
            {"type":"taskList","content":items}]})
    }

    fn save(db: &Database, id: &str, doc: &Value) {
        db.save_content(id, &doc.to_string()).unwrap();
    }

    fn note_with_checklist(db: &Database, checked: bool) -> String {
        let id = db.create_note(None).unwrap().id;
        save(
            db,
            &id,
            &checklist(vec![task("a", checked), task("b", false)]),
        );
        id
    }

    fn ago(days: i64) -> i64 {
        now_ms() - days * DAY_MS
    }

    #[test]
    fn cutoff_is_whole_days_of_milliseconds() {
        assert_eq!(cutoff_ms(1_000_000_000_000, 0), 1_000_000_000_000);
        assert_eq!(
            cutoff_ms(1_000_000_000_000, 7),
            1_000_000_000_000 - 7 * DAY_MS
        );
        assert_eq!(cutoff_ms(0, 365), -365 * 86_400_000);
    }

    fn set_col(db: &Database, id: &str, column: &str, value: Option<i64>) {
        db.conn
            .execute(
                &format!("UPDATE notes SET {column} = ?2 WHERE id = ?1"),
                params![id, value],
            )
            .unwrap();
    }

    fn lock_with_pin(db: &Database) {
        db.set_setting(PIN_HASH, "hash").unwrap();
        db.set_privacy_locked(true, &[]);
    }

    #[test]
    fn defaults_are_all_off() {
        let a = db().automations().unwrap();
        assert_eq!(
            a,
            Automations {
                auto_complete_checklists: false,
                reset_checklists_on_repeat: false,
                archive_done_enabled: false,
                archive_done_days: 7,
                purge_trash_enabled: false,
                purge_trash_days: 30,
                purge_off_by_restore: false,
            }
        );
    }

    #[test]
    fn set_automations_validates_ranges() {
        let db = db();
        for (days, ok) in [(0, false), (1, true), (90, true), (91, false)] {
            let a = Automations {
                archive_done_days: days,
                ..on()
            };
            let r = db.set_automations(&a);
            assert_eq!(r.is_ok(), ok, "archive {days}");
            if !ok {
                let e = r.unwrap_err();
                assert_eq!(e.code(), "validation");
                assert!(e.to_string().contains("archiveDoneDays"), "{e}");
            }
        }
        for (days, ok) in [(6, false), (7, true), (365, true), (366, false)] {
            let a = Automations {
                purge_trash_days: days,
                ..on()
            };
            let r = db.set_automations(&a);
            assert_eq!(r.is_ok(), ok, "purge {days}");
            if !ok {
                let e = r.unwrap_err();
                assert_eq!(e.code(), "validation");
                assert!(e.to_string().contains("purgeTrashDays"), "{e}");
            }
        }

        // A refusal changes nothing, not even the switches.
        let before = db
            .set_automations(&Automations {
                archive_done_days: 10,
                purge_trash_days: 40,
                ..Automations {
                    auto_complete_checklists: false,
                    reset_checklists_on_repeat: false,
                    archive_done_enabled: false,
                    purge_trash_enabled: false,
                    ..on()
                }
            })
            .unwrap();
        assert!(
            db.set_automations(&Automations {
                purge_trash_days: 5,
                ..on()
            })
            .is_err()
        );
        assert_eq!(db.automations().unwrap(), before);
    }

    #[test]
    fn set_automations_round_trips_and_ignores_the_restore_flag() {
        let db = db();
        db.enable_purge_trash(30).unwrap();
        let saved = db
            .set_automations(&Automations {
                purge_off_by_restore: true,
                archive_done_days: 12,
                ..on()
            })
            .unwrap();
        assert!(saved.auto_complete_checklists && saved.purge_trash_enabled);
        assert_eq!(saved.archive_done_days, 12);
        assert!(!saved.purge_off_by_restore, "input flag is ignored");
        assert_eq!(db.automations().unwrap(), saved);

        // Switching a rule off keeps its days.
        let off = db
            .set_automations(&Automations {
                archive_done_enabled: false,
                ..saved
            })
            .unwrap();
        assert!(!off.archive_done_enabled);
        assert_eq!(off.archive_done_days, 12);
    }

    #[test]
    fn set_automations_never_turns_purge_on() {
        // Stored off, input on: rule 4 stays off, the other fields are saved,
        // and a restore note is not cleared.
        let db = db();
        db.set_setting(PURGE_TRASH_OFF_BY_RESTORE, "1").unwrap();
        let saved = db
            .set_automations(&Automations {
                archive_done_days: 12,
                purge_trash_days: 50,
                ..on()
            })
            .unwrap();
        assert!(!saved.purge_trash_enabled, "must stay off");
        assert!(saved.purge_off_by_restore, "the note stays");
        assert!(saved.auto_complete_checklists && saved.reset_checklists_on_repeat);
        assert!(saved.archive_done_enabled);
        assert_eq!((saved.archive_done_days, saved.purge_trash_days), (12, 50));
        assert_eq!(db.automations().unwrap(), saved);

        // Stored on, input on with new days: the days are saved, it stays on.
        db.enable_purge_trash(30).unwrap();
        let saved = db
            .set_automations(&Automations {
                purge_trash_days: 20,
                ..on()
            })
            .unwrap();
        assert!(saved.purge_trash_enabled);
        assert_eq!(saved.purge_trash_days, 20);

        // Turning it off still works.
        let saved = db
            .set_automations(&Automations {
                purge_trash_enabled: false,
                ..on()
            })
            .unwrap();
        assert!(!saved.purge_trash_enabled);
    }

    #[test]
    fn enable_purge_trash_turns_on_and_clears_restore_flag() {
        let db = db();
        db.set_setting(PURGE_TRASH_OFF_BY_RESTORE, "1").unwrap();
        db.set_automations(&Automations {
            archive_done_days: 9,
            ..Automations {
                auto_complete_checklists: false,
                reset_checklists_on_repeat: false,
                archive_done_enabled: false,
                purge_trash_enabled: false,
                ..on()
            }
        })
        .unwrap();
        let saved = db.enable_purge_trash(45).unwrap();
        assert!(saved.purge_trash_enabled && !saved.purge_off_by_restore);
        assert_eq!(saved.purge_trash_days, 45);
        assert_eq!(saved.archive_done_days, 9, "other settings are untouched");
        assert_eq!(db.automations().unwrap(), saved);

        // Out of range: refused, nothing changes.
        db.set_automations(&Automations {
            purge_trash_enabled: false,
            ..saved
        })
        .unwrap();
        let before = db.automations().unwrap();
        for days in [0, 6, 366, u32::MAX] {
            let e = db.enable_purge_trash(days).unwrap_err();
            assert_eq!(e.code(), "validation", "{days}");
            assert!(e.to_string().contains("purgeTrashDays"), "{e}");
        }
        assert_eq!(db.automations().unwrap(), before);
        assert!(!before.purge_trash_enabled);
    }

    #[test]
    fn damaged_stored_values_fall_back_to_defaults() {
        let db = db();
        db.set_setting(ARCHIVE_DONE_DAYS, "0").unwrap();
        db.set_setting(PURGE_TRASH_DAYS, "abc").unwrap();
        db.set_setting(ARCHIVE_DONE_ENABLED, "true").unwrap();
        let a = db.automations().unwrap();
        assert_eq!((a.archive_done_days, a.purge_trash_days), (7, 30));
        assert!(!a.archive_done_enabled, "only \"1\" turns a rule on");
    }

    #[test]
    fn archive_done_before_archives_only_old_done_notes() {
        let db = db();
        let old = db.create_note(None).unwrap().id;
        let recent = db.create_note(None).unwrap().id;
        let open = db.create_note(None).unwrap().id;
        let archived = db.create_note(None).unwrap().id;
        let trashed = db.create_note(None).unwrap().id;
        set_col(&db, &old, "completed_at", Some(ago(8)));
        set_col(&db, &recent, "completed_at", Some(ago(6)));
        for id in [&archived, &trashed] {
            set_col(&db, id, "completed_at", Some(ago(20)));
        }
        db.set_archived(&archived, true).unwrap();
        let archived_at = db.get_note(&archived).unwrap().archived_at;
        db.trash_note(&trashed).unwrap();

        let n = db.archive_done_before(ago(7)).unwrap();
        assert_eq!(n, 1);
        let note = db.get_note(&old).unwrap();
        assert!(note.archived_at.is_some());
        assert!(!note.window.visible, "archiving hides the window");
        assert_eq!(
            note.completed_at.map(|t| t < ago(7)),
            Some(true),
            "still done"
        );
        assert!(db.get_note(&recent).unwrap().archived_at.is_none());
        assert!(db.get_note(&open).unwrap().archived_at.is_none());
        assert_eq!(db.get_note(&archived).unwrap().archived_at, archived_at);
        assert!(db.get_note(&trashed).unwrap().archived_at.is_none());
        assert_eq!(db.archive_done_before(ago(7)).unwrap(), 0, "nothing left");
    }

    #[test]
    fn purge_trashed_before_and_count_agree() {
        let db = db();
        let ids: Vec<String> = [40, 31, 29]
            .iter()
            .map(|&d| {
                let id = db.create_note(None).unwrap().id;
                db.trash_note(&id).unwrap();
                set_col(&db, &id, "deleted_at", Some(ago(d)));
                id
            })
            .collect();
        let live = db.create_note(None).unwrap().id;

        let cutoff = ago(30);
        assert_eq!(db.count_purgeable(cutoff).unwrap(), 2);
        assert_eq!(db.purge_trashed_before(cutoff).unwrap(), 2);
        assert_eq!(db.get_note(&ids[0]).unwrap_err().code(), "not_found");
        assert_eq!(db.get_note(&ids[1]).unwrap_err().code(), "not_found");
        assert!(db.get_note(&ids[2]).is_ok(), "29 days old stays");
        assert!(db.get_note(&live).is_ok(), "active notes are never purged");
        assert_eq!(db.count_purgeable(cutoff).unwrap(), 0);
    }

    #[test]
    fn purge_cascades_to_windows_and_reminders() {
        let db = db();
        let id = db.create_note(None).unwrap().id;
        let rule = validate_rule("2026-01-01", "09:00", "daily").unwrap();
        db.set_reminder(&id, rule, Utc::now(), &Utc).unwrap();
        db.trash_note(&id).unwrap();
        set_col(&db, &id, "deleted_at", Some(ago(60)));
        assert_eq!(db.purge_trashed_before(ago(30)).unwrap(), 1);
        for table in ["notes", "note_windows", "reminders"] {
            let rows: i64 = db
                .conn
                .query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r.get(0))
                .unwrap();
            assert_eq!(rows, 0, "{table}");
        }
    }

    #[test]
    fn rules_skip_locked_private_notes() {
        let db = db();
        let done = db.create_note(None).unwrap().id;
        let done_private = db.create_note(None).unwrap().id;
        let trashed = db.create_note(None).unwrap().id;
        let trashed_private = db.create_note(None).unwrap().id;
        let checklist_private = note_with_checklist(&db, true);
        for id in [&done, &done_private] {
            set_col(&db, id, "completed_at", Some(ago(10)));
        }
        for id in [&trashed, &trashed_private] {
            db.trash_note(id).unwrap();
            set_col(&db, id, "deleted_at", Some(ago(40)));
        }
        for id in [&done_private, &trashed_private, &checklist_private] {
            db.set_private(id, true, "").unwrap();
        }
        lock_with_pin(&db);

        assert_eq!(
            db.archive_done_before(ago(7)).unwrap(),
            1,
            "only the public one"
        );
        assert_eq!(db.count_purgeable(ago(30)).unwrap(), 1);
        assert_eq!(db.purge_trashed_before(ago(30)).unwrap(), 1);
        assert_eq!(
            db.untick_checklist(&checklist_private).unwrap_err().code(),
            "private_locked"
        );

        // Unlocked, the private notes are fair game again.
        db.set_privacy_locked(false, &[]);
        assert!(db.get_note(&done_private).unwrap().archived_at.is_none());
        assert!(db.get_note(&trashed_private).is_ok());
        assert_eq!(db.count_purgeable(ago(30)).unwrap(), 1);
        assert_eq!(db.archive_done_before(ago(7)).unwrap(), 1);
        assert_eq!(db.purge_trashed_before(ago(30)).unwrap(), 1);
        assert!(db.untick_checklist(&checklist_private).unwrap());
    }

    #[test]
    fn untick_all_unticks_nested_items() {
        let nested = json!({"type":"doc","content":[
            {"type":"paragraph","content":[{"type":"text","text":"Title"}]},
            {"type":"taskList","content":[
                task("one", true),
                {"type":"taskItem","attrs":{"checked":true},"content":[
                    {"type":"paragraph","content":[{"type":"text","text":"two"}]},
                    {"type":"taskList","content":[task("two-a", true), task("two-b", false)]}]}]},
            {"type":"bulletList","content":[{"type":"listItem","content":[
                {"type":"paragraph","content":[{"type":"text","text":"plain"}]},
                {"type":"taskList","content":[task("deep", true)]}]}]}]});
        let out = untick_all(&nested).unwrap();
        let text = out.to_string();
        assert!(!text.contains("\"checked\":true"), "{text}");
        assert_eq!(text.matches("\"checked\":false").count(), 5);

        // Everything but the ticks is identical.
        let ticked = nested
            .to_string()
            .replace("\"checked\":true", "\"checked\":false");
        assert_eq!(text, ticked);

        let none = checklist(vec![task("a", false), task("b", false)]);
        assert_eq!(untick_all(&none), None);
        let plain = json!({"type":"doc","content":[{"type":"paragraph"}]});
        assert_eq!(untick_all(&plain), None);
    }

    #[test]
    fn untick_checklist_saves_and_refuses_edit_locked() {
        let db = db();
        let id = db.create_note(None).unwrap().id;
        save(
            &db,
            &id,
            &checklist(vec![task("Milk", true), task("Eggs", true)]),
        );
        let before = db.get_note(&id).unwrap();

        assert!(db.untick_checklist(&id).unwrap());
        let after = db.get_note(&id).unwrap();
        assert!(!after.content.to_string().contains("\"checked\":true"));
        assert_eq!(after.title, "Morning Routine");
        let search: String = db
            .conn
            .query_row("SELECT search_text FROM notes WHERE id = ?1", [&id], |r| {
                r.get(0)
            })
            .unwrap();
        assert!(
            search.contains("milk") && search.contains("morning routine"),
            "{search}"
        );
        assert!(after.updated_at >= before.updated_at);
        assert!(!db.untick_checklist(&id).unwrap(), "nothing left to untick");

        // Edit-locked: refused, nothing changes.
        save(&db, &id, &checklist(vec![task("Milk", true)]));
        db.set_edit_locked(&id, true).unwrap();
        let locked = db.get_note(&id).unwrap();
        assert_eq!(db.untick_checklist(&id).unwrap_err().code(), "not_allowed");
        assert_eq!(db.get_note(&id).unwrap(), locked);

        assert_eq!(
            db.untick_checklist("missing").unwrap_err().code(),
            "not_found"
        );
    }

    #[test]
    fn reset_only_on_the_first_fire_of_an_occurrence() {
        let db = db();
        db.set_automations(&on()).unwrap();
        let id = note_with_checklist(&db, true);
        let rule = validate_rule("2026-01-01", "09:00", "daily").unwrap();
        let now = Utc::now();
        let r = db.set_reminder(&id, rule, now, &Utc).unwrap();

        assert!(db.checklist_reset_due(&id, r.due_at).unwrap());

        // After a snooze the next fire is at snoozed_until, and does not count.
        let s = db
            .snooze_reminder(&id, Snooze::Minutes10, now, &Utc)
            .unwrap();
        assert!(
            !db.checklist_reset_due(&id, s.snoozed_until.unwrap())
                .unwrap()
        );

        // One-off reminder.
        let one_off = validate_rule("2099-01-01", "09:00", "none").unwrap();
        let o = db.set_reminder(&id, one_off, now, &Utc).unwrap();
        assert!(!db.checklist_reset_due(&id, o.due_at).unwrap());
        db.set_reminder(&id, rule, now, &Utc).unwrap();
        assert!(db.checklist_reset_due(&id, r.due_at).unwrap());

        // No reminder at all.
        let bare = note_with_checklist(&db, true);
        assert!(!db.checklist_reset_due(&bare, r.due_at).unwrap());

        // Rule 2 off.
        db.set_automations(&Automations {
            reset_checklists_on_repeat: false,
            ..on()
        })
        .unwrap();
        assert!(!db.checklist_reset_due(&id, r.due_at).unwrap());
        db.set_automations(&on()).unwrap();
        assert!(db.checklist_reset_due(&id, r.due_at).unwrap());

        // No ticked item.
        let unticked = note_with_checklist(&db, false);
        db.set_reminder(&unticked, rule, now, &Utc).unwrap();
        assert!(!db.checklist_reset_due(&unticked, r.due_at).unwrap());

        // Edit-locked, archived, withheld.
        db.set_edit_locked(&id, true).unwrap();
        assert!(!db.checklist_reset_due(&id, r.due_at).unwrap());
        db.set_edit_locked(&id, false).unwrap();
        db.set_archived(&id, true).unwrap();
        assert!(!db.checklist_reset_due(&id, r.due_at).unwrap());
        db.set_archived(&id, false).unwrap();
        db.set_private(&id, true, "").unwrap();
        lock_with_pin(&db);
        assert!(!db.checklist_reset_due(&id, r.due_at).unwrap());
        db.set_privacy_locked(false, &[]);
        assert!(db.checklist_reset_due(&id, r.due_at).unwrap());

        // Completed.
        db.set_completed(&id, true, now_ms()).unwrap();
        assert!(!db.checklist_reset_due(&id, r.due_at).unwrap());
    }
}
