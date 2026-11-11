//! Reminder storage, catch-up and listing (spec §3.3, §3.5, §4). One reminder per note.
//!
//! Conventions: stored times are UTC Unix milliseconds (`i64`) like every other
//! timestamp; `now` arguments are `DateTime<Utc>` and `tz` is the computer's time zone
//! (`chrono::Local` in the app, a fixed IANA zone in tests), so nothing here reads a
//! clock. All time rules live in [`crate::reminders`].
//!
//! A stored row whose values cannot be read back (a date that is not a date, an unknown
//! repeat, a time chrono cannot represent) is treated as absent by every read: it is
//! never listed, never fires and never wakes the scheduler, and it cannot crash the app.
//! Setting a new reminder on that note replaces it. Nothing is deleted behind the user's
//! back.

use chrono::{DateTime, TimeDelta, TimeZone, Utc};
use rusqlite::{OptionalExtension, Row, params};

use super::Database;
use super::notes::display_label;
use crate::error::{CoreError, CoreResult};
use crate::reminders::{
    FAR_REMINDER, PAST_REMINDER, Reminder, ReminderHeading, ReminderRow, ReminderRule, Repeat,
    Snooze, first_due, next_occurrence, snooze, validate_rule, within_range,
};

const COLUMNS: &str = "r.note_id, r.local_date, r.local_time, r.repeat, r.due_at, \
                       r.snoozed_until, r.fired_at";

fn invalid(msg: impl Into<String>) -> CoreError {
    CoreError::Validation(msg.into())
}

fn at(ms: i64) -> Option<DateTime<Utc>> {
    DateTime::from_timestamp_millis(ms)
}

/// Read columns 0..=6 of [`COLUMNS`]. `None` means the row is damaged.
fn reminder_from_row(r: &Row<'_>) -> Option<Reminder> {
    let note_id: String = r.get(0).ok()?;
    let date: String = r.get(1).ok()?;
    let time: String = r.get(2).ok()?;
    let repeat: String = r.get(3).ok()?;
    let due_at: i64 = r.get(4).ok()?;
    let snoozed_until: Option<i64> = r.get(5).ok()?;
    let fired_at: Option<i64> = r.get(6).ok()?;
    let rule = validate_rule(&date, &time, &repeat).ok()?;
    // Every stored instant must be representable, or it cannot be compared or advanced.
    [Some(due_at), snoozed_until, fired_at]
        .into_iter()
        .flatten()
        .all(|ms| at(ms).is_some())
        .then_some(Reminder {
            note_id,
            rule,
            due_at,
            snoozed_until,
            fired_at,
        })
}

/// The due time of a rule that is being set: a one-off's own date and time, or a repeat's
/// first real occurrence after `floor` and not before the rule's own time (ruling R3), so
/// a Weekdays rule dated on a Saturday starts on Monday.
fn due_for<Tz: TimeZone>(
    rule: &ReminderRule,
    floor: DateTime<Utc>,
    tz: &Tz,
) -> Option<DateTime<Utc>> {
    let first = first_due(rule, tz);
    if rule.repeat == Repeat::None {
        return Some(first);
    }
    let anchor = first
        .checked_sub_signed(TimeDelta::seconds(1))
        .unwrap_or(first);
    next_occurrence(rule, floor.max(anchor), tz)
}

/// The latest occurrence of a repeat that is at or before `now`, if any occurrence
/// follows `from`.
fn latest_occurrence_by<Tz: TimeZone>(
    rule: &ReminderRule,
    from: DateTime<Utc>,
    now: DateTime<Utc>,
    tz: &Tz,
) -> Option<DateTime<Utc>> {
    let mut latest = next_occurrence(rule, from, tz).filter(|n| *n <= now)?;
    // A repeat is at most daily, so even a century of absence is a bounded loop.
    for _ in 0..40_000 {
        match next_occurrence(rule, latest, tz) {
            Some(n) if n <= now => latest = n,
            _ => break,
        }
    }
    Some(latest)
}

impl Database {
    /// Refuse a note that is missing (`NotFound`) or in the trash (`NotAllowed`).
    fn ensure_not_trashed(&self, note_id: &str) -> CoreResult<()> {
        let deleted: Option<bool> = self
            .conn
            .query_row(
                "SELECT deleted_at IS NOT NULL FROM notes WHERE id = ?1",
                [note_id],
                |r| r.get(0),
            )
            .optional()?;
        match deleted {
            None => Err(CoreError::NotFound(note_id.to_string())),
            Some(true) => Err(CoreError::NotAllowed(
                "restore the note from the trash first".into(),
            )),
            Some(false) => Ok(()),
        }
    }

    /// `snoozed_until` if set, else `due_at`.
    pub fn effective_due(reminder: &Reminder) -> i64 {
        reminder.effective_due()
    }

    /// The note's reminder, or `None` if it has none (or its stored row is damaged).
    pub fn reminder(&self, note_id: &str) -> CoreResult<Option<Reminder>> {
        let sql = format!("SELECT {COLUMNS} FROM reminders r WHERE r.note_id = ?1");
        let row = self
            .conn
            .query_row(&sql, [note_id], |r| Ok(reminder_from_row(r)))
            .optional()?;
        Ok(row.flatten())
    }

    /// Every readable reminder on a note that is not in the trash and not done (archived
    /// included). A done note's reminder is kept but never fires; after Reopen it is
    /// overdue like one restored from the trash.
    fn live_reminders(&self) -> CoreResult<Vec<Reminder>> {
        self.reminders_where("n.deleted_at IS NULL AND n.completed_at IS NULL")
    }

    /// Every readable reminder, trashed notes included, for a backup.
    pub(super) fn all_reminders(&self) -> CoreResult<Vec<Reminder>> {
        self.reminders_where("1")
    }

    fn reminders_where(&self, condition: &str) -> CoreResult<Vec<Reminder>> {
        let sql = format!(
            "SELECT {COLUMNS} FROM reminders r JOIN notes n ON n.id = r.note_id
             WHERE {condition}"
        );
        let mut stmt = self.conn.prepare(&sql)?;
        let rows = stmt.query_map([], |r| Ok(reminder_from_row(r)))?;
        let mut out = Vec::new();
        for row in rows {
            out.extend(row?);
        }
        out.sort_by(|a, b| (a.effective_due(), &a.note_id).cmp(&(b.effective_due(), &b.note_id)));
        Ok(out)
    }

    /// Give a note its reminder, replacing any earlier one; the snooze and the fired
    /// mark are cleared.
    ///
    /// The due time is the rule's own date and time for a one-off, which must be after
    /// `now` ("Pick a time in the future."); for a repeat it is the first real occurrence
    /// at or after the rule's time and after `now` (ruling R3), so a Weekdays reminder
    /// dated on a Saturday starts on Monday. Anything more than 100 years away is refused.
    pub fn set_reminder<Tz: TimeZone>(
        &self,
        note_id: &str,
        rule: ReminderRule,
        now: DateTime<Utc>,
        tz: &Tz,
    ) -> CoreResult<Reminder> {
        self.ensure_not_trashed(note_id)?;
        let due = match due_for(&rule, now, tz) {
            Some(due) if rule.repeat == Repeat::None && due <= now => {
                return Err(invalid(PAST_REMINDER));
            }
            Some(due) => due,
            None => return Err(invalid(FAR_REMINDER)),
        };
        let due_ms = due.timestamp_millis();
        if !within_range(due_ms, now.timestamp_millis()) {
            return Err(invalid(FAR_REMINDER));
        }
        self.conn.execute(
            "INSERT INTO reminders (note_id, local_date, local_time, repeat, due_at,
                                    snoozed_until, fired_at)
             VALUES (?1, ?2, ?3, ?4, ?5, NULL, NULL)
             ON CONFLICT(note_id) DO UPDATE SET
                 local_date = excluded.local_date, local_time = excluded.local_time,
                 repeat = excluded.repeat, due_at = excluded.due_at,
                 snoozed_until = NULL, fired_at = NULL",
            params![
                note_id,
                rule.local_date.format("%Y-%m-%d").to_string(),
                rule.local_time.format("%H:%M").to_string(),
                rule.repeat.as_str(),
                due_ms
            ],
        )?;
        Ok(Reminder {
            note_id: note_id.to_string(),
            rule,
            due_at: due_ms,
            snoozed_until: None,
            fired_at: None,
        })
    }

    /// Delete the note's reminder. Not an error if there is none.
    pub fn remove_reminder(&self, note_id: &str) -> CoreResult<()> {
        self.conn
            .execute("DELETE FROM reminders WHERE note_id = ?1", [note_id])?;
        Ok(())
    }

    /// Reminders to notify now: on notes not in the trash and not done (archived ones included), with
    /// `effective_due <= now` and not already notified for that effective due time.
    /// Ordered by due time. Restoring a trashed note whose reminder passed makes it
    /// appear here once: it was never notified for that time.
    ///
    /// First, in one transaction, every repeat whose next occurrence after its effective
    /// due time is already at or before `now` is advanced to the latest such occurrence
    /// (ruling R5): its snooze is cleared and `fired_at` kept, so the new occurrence is
    /// due exactly once, however many were missed. A repeat that fired and was never
    /// dismissed therefore fires again at its next occurrence. One-offs stay overdue
    /// until dismissed.
    pub fn due_reminders<Tz: TimeZone>(
        &self,
        now: DateTime<Utc>,
        tz: &Tz,
    ) -> CoreResult<Vec<Reminder>> {
        let now_ms = now.timestamp_millis();
        let tx = self.conn.unchecked_transaction()?;
        for r in self.live_reminders()? {
            if r.rule.repeat == Repeat::None {
                continue;
            }
            let Some(from) = at(r.effective_due()) else {
                continue;
            };
            if let Some(latest) = latest_occurrence_by(&r.rule, from, now, tz) {
                tx.execute(
                    "UPDATE reminders SET due_at = ?3, snoozed_until = NULL
                     WHERE note_id = ?1 AND due_at = ?2",
                    params![r.note_id, r.due_at, latest.timestamp_millis()],
                )?;
            }
        }
        tx.commit()?;
        Ok(self
            .live_reminders()?
            .into_iter()
            .filter(|r| r.effective_due() <= now_ms && r.fired_at != Some(r.effective_due()))
            .collect())
    }

    /// Record that the notification for this effective due time was sent, so a restart
    /// never sends it again. Does nothing if the reminder has since changed (a different
    /// effective due time) or is gone.
    pub fn mark_fired(&self, note_id: &str, effective_due: i64) -> CoreResult<()> {
        self.conn.execute(
            "UPDATE reminders SET fired_at = ?2
             WHERE note_id = ?1 AND coalesce(snoozed_until, due_at) = ?2",
            params![note_id, effective_due],
        )?;
        Ok(())
    }

    /// Snooze: the reminder fires again at `snooze(now, by, rule, tz)`. The rule and
    /// `due_at` are untouched, so a repeat keeps its wall-clock anchor.
    pub fn snooze_reminder<Tz: TimeZone>(
        &self,
        note_id: &str,
        by: Snooze,
        now: DateTime<Utc>,
        tz: &Tz,
    ) -> CoreResult<Reminder> {
        let mut r = self
            .reminder(note_id)?
            .ok_or_else(|| CoreError::NotFound(note_id.to_string()))?;
        self.ensure_not_trashed(note_id)?;
        let until = snooze(now, by, &r.rule, tz).timestamp_millis();
        if !within_range(until, now.timestamp_millis()) {
            return Err(invalid(FAR_REMINDER));
        }
        self.conn.execute(
            "UPDATE reminders SET snoozed_until = ?2 WHERE note_id = ?1",
            params![note_id, until],
        )?;
        r.snoozed_until = Some(until);
        Ok(r)
    }

    /// Dismiss: a one-off is deleted (`None`); a repeat moves to its next occurrence
    /// after `max(now, due_at)` with the snooze and fired mark cleared. A repeat with no
    /// further occurrence is deleted too.
    pub fn dismiss_reminder<Tz: TimeZone>(
        &self,
        note_id: &str,
        now: DateTime<Utc>,
        tz: &Tz,
    ) -> CoreResult<Option<Reminder>> {
        let mut r = self
            .reminder(note_id)?
            .ok_or_else(|| CoreError::NotFound(note_id.to_string()))?;
        self.ensure_not_trashed(note_id)?;
        let due_at = at(r.due_at).unwrap_or(now);
        let next = (r.rule.repeat != Repeat::None)
            .then(|| next_occurrence(&r.rule, now.max(due_at), tz))
            .flatten()
            .map(|d| d.timestamp_millis())
            .filter(|ms| within_range(*ms, now.timestamp_millis()));
        let Some(next) = next else {
            self.remove_reminder(note_id)?;
            return Ok(None);
        };
        self.conn.execute(
            "UPDATE reminders SET due_at = ?2, snoozed_until = NULL, fired_at = NULL
             WHERE note_id = ?1",
            params![note_id, next],
        )?;
        r.due_at = next;
        r.snoozed_until = None;
        r.fired_at = None;
        Ok(Some(r))
    }

    /// When the scheduler should wake: the earliest time after `now` at which a reminder
    /// on a note that is not in the trash and not done is due. That is its effective due time, or for
    /// a repeat that already fired for its effective due time, its next occurrence
    /// (ruling R5). `None` if nothing is coming. Reminders already due are handled by
    /// [`Database::due_reminders`], which the scheduler calls first.
    pub fn next_wake<Tz: TimeZone>(&self, now: DateTime<Utc>, tz: &Tz) -> CoreResult<Option<i64>> {
        let now_ms = now.timestamp_millis();
        Ok(self
            .live_reminders()?
            .into_iter()
            .filter_map(|r| {
                let due = r.effective_due();
                if due > now_ms {
                    return Some(due);
                }
                if r.rule.repeat == Repeat::None || r.fired_at != Some(due) {
                    return None;
                }
                next_occurrence(&r.rule, at(due)?, tz)
                    .map(|n| n.timestamp_millis())
                    .filter(|n| *n > now_ms)
            })
            .min())
    }

    /// After the computer's time zone changed (ruling R4): re-derive the due time of every
    /// reminder that has not fired and is not snoozed, so it keeps its wall-clock time.
    /// A one-off gets its own date and time in `tz` (it may now be overdue; it is kept);
    /// a repeat whose due time is still ahead gets its next occurrence after `now`.
    /// Fired, snoozed and unreadable rows are left alone; notes in the trash are included,
    /// so a restored note is right. Returns how many rows changed.
    pub fn reanchor_reminders<Tz: TimeZone>(
        &self,
        now: DateTime<Utc>,
        tz: &Tz,
    ) -> CoreResult<usize> {
        let now_ms = now.timestamp_millis();
        let floor = now.checked_sub_signed(TimeDelta::seconds(1)).unwrap_or(now);
        let tx = self.conn.unchecked_transaction()?;
        let mut changed = 0;
        for r in self.all_reminders()? {
            if r.fired_at.is_some() || r.snoozed_until.is_some() {
                continue;
            }
            if r.rule.repeat != Repeat::None && r.due_at <= now_ms {
                continue;
            }
            let Some(new) = due_for(&r.rule, floor, tz).map(|d| d.timestamp_millis()) else {
                continue;
            };
            if new == r.due_at || !within_range(new, now_ms) {
                continue;
            }
            changed += tx.execute(
                "UPDATE reminders SET due_at = ?3
                 WHERE note_id = ?1 AND due_at = ?2
                   AND fired_at IS NULL AND snoozed_until IS NULL",
                params![r.note_id, r.due_at, new],
            )?;
        }
        tx.commit()?;
        Ok(changed)
    }

    /// The note's title and whether the lock withholds it now, for the notification of
    /// its reminder (ruling R6). `None` when the note does not exist. The title is the
    /// real one: the shell replaces it with "Private note" when `locked`.
    pub fn reminder_heading(&self, note_id: &str) -> CoreResult<Option<ReminderHeading>> {
        let row = self
            .conn
            .query_row(
                "SELECT title, private FROM notes WHERE id = ?1",
                [note_id],
                |r| Ok((r.get::<_, String>(0)?, r.get::<_, bool>(1)?)),
            )
            .optional()?;
        let Some((title, private)) = row else {
            return Ok(None);
        };
        let lock = self.lock_active()?;
        Ok(Some(ReminderHeading {
            title,
            locked: self.withheld(lock, private, note_id),
        }))
    }

    /// Every reminder on a note that is not in the trash and not done (archived included), earliest
    /// effective due first, for the manager's Reminders tab. `query` filters by title,
    /// case-insensitively and Unicode-aware (the way note search lowercases); a blank
    /// query lists all. While a private note is locked the query matches its neutral
    /// label instead of its title, so searching cannot probe a hidden title. The row's
    /// `title` is always the real title: masking is the shell's job (ruling R1).
    pub fn list_reminders(&self, query: &str, now: DateTime<Utc>) -> CoreResult<Vec<ReminderRow>> {
        let needle = query.trim().to_lowercase();
        let now_ms = now.timestamp_millis();
        let lock = self.lock_active()?;
        let sql = format!(
            "SELECT {COLUMNS}, n.title, n.color, n.private, n.private_label,
                    n.archived_at IS NOT NULL
             FROM reminders r JOIN notes n ON n.id = r.note_id
             WHERE n.deleted_at IS NULL AND n.completed_at IS NULL"
        );
        let mut stmt = self.conn.prepare(&sql)?;
        let rows = stmt.query_map([], |r| {
            Ok((
                reminder_from_row(r),
                r.get::<_, String>(7)?,
                r.get::<_, String>(8)?,
                r.get::<_, bool>(9)?,
                r.get::<_, String>(10)?,
                r.get::<_, bool>(11)?,
            ))
        })?;
        let mut out = Vec::new();
        for row in rows {
            let (Some(reminder), title, color, private, label, archived) = row? else {
                continue;
            };
            let locked = self.withheld(lock, private, &reminder.note_id);
            let locked_label = display_label(&label).to_owned();
            if !needle.is_empty() {
                let searched = if locked {
                    locked_label.to_lowercase()
                } else {
                    title.to_lowercase()
                };
                if !searched.contains(&needle) {
                    continue;
                }
            }
            let due = reminder.effective_due();
            out.push(ReminderRow {
                note_id: reminder.note_id,
                title,
                color,
                private,
                locked_label,
                repeat: reminder.rule.repeat,
                effective_due: due,
                overdue: due <= now_ms,
                locked,
                archived,
            });
        }
        out.sort_by(|a, b| (a.effective_due, &a.note_id).cmp(&(b.effective_due, &b.note_id)));
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use chrono_tz::Europe::Paris;

    use super::*;
    use crate::reminders::validate_rule;

    fn utc(y: i32, mo: u32, d: u32, h: u32, mi: u32) -> DateTime<Utc> {
        Utc.with_ymd_and_hms(y, mo, d, h, mi, 0).unwrap()
    }

    /// Wednesday 4 Nov 2026, 11:00 in Paris (CET, UTC+1).
    fn now() -> DateTime<Utc> {
        utc(2026, 11, 4, 10, 0)
    }

    fn ms(t: DateTime<Utc>) -> i64 {
        t.timestamp_millis()
    }

    fn rule(date: &str, time: &str, repeat: &str) -> ReminderRule {
        validate_rule(date, time, repeat).unwrap()
    }

    fn db_with_note() -> (Database, String) {
        let db = Database::open_in_memory().unwrap();
        let id = db.create_note(None).unwrap().id;
        (db, id)
    }

    /// A one-off today at 14:00 Paris (13:00 UTC).
    fn set_one_off(db: &Database, id: &str) -> Reminder {
        db.set_reminder(id, rule("2026-11-04", "14:00", "none"), now(), &Paris)
            .unwrap()
    }

    #[test]
    fn set_read_and_remove_a_reminder() {
        let (db, id) = db_with_note();
        assert_eq!(db.reminder(&id).unwrap(), None);

        let set = set_one_off(&db, &id);
        assert_eq!(set.due_at, ms(utc(2026, 11, 4, 13, 0)));
        assert_eq!(set.snoozed_until, None);
        assert_eq!(set.fired_at, None);
        assert_eq!(db.reminder(&id).unwrap(), Some(set.clone()));
        assert_eq!(Database::effective_due(&set), set.due_at);

        // Setting again replaces it.
        let changed = db
            .set_reminder(&id, rule("2026-11-05", "09:30", "daily"), now(), &Paris)
            .unwrap();
        assert_eq!(changed.due_at, ms(utc(2026, 11, 5, 8, 30)));
        assert_eq!(db.reminder(&id).unwrap(), Some(changed));

        db.remove_reminder(&id).unwrap();
        assert_eq!(db.reminder(&id).unwrap(), None);
        db.remove_reminder(&id).unwrap(); // removing nothing is fine
    }

    #[test]
    fn a_past_one_off_is_refused_with_the_exact_message() {
        let (db, id) = db_with_note();
        for (date, time) in [
            ("2026-11-04", "11:00"),
            ("2026-11-04", "09:00"),
            ("2020-01-01", "08:00"),
        ] {
            let err = db
                .set_reminder(&id, rule(date, time, "none"), now(), &Paris)
                .unwrap_err();
            assert_eq!(err.code(), "validation");
            assert!(err.to_string().contains(PAST_REMINDER), "{err}");
            assert_eq!(PAST_REMINDER, "Pick a time in the future.");
        }
        assert_eq!(db.reminder(&id).unwrap(), None, "nothing stored");
        // One minute ahead is fine.
        db.set_reminder(&id, rule("2026-11-04", "11:01", "none"), now(), &Paris)
            .unwrap();
    }

    #[test]
    fn a_failed_set_keeps_the_existing_reminder() {
        let (db, id) = db_with_note();
        let kept = set_one_off(&db, &id);
        assert!(
            db.set_reminder(&id, rule("2020-01-01", "08:00", "none"), now(), &Paris)
                .is_err()
        );
        assert_eq!(db.reminder(&id).unwrap(), Some(kept));
    }

    #[test]
    fn a_repeat_dated_in_the_past_starts_at_its_next_real_occurrence() {
        let (db, id) = db_with_note();
        // Daily 09:00 picked long ago: next is tomorrow 09:00 Paris (today's has passed).
        let daily = db
            .set_reminder(&id, rule("2026-01-01", "09:00", "daily"), now(), &Paris)
            .unwrap();
        assert_eq!(daily.due_at, ms(utc(2026, 11, 5, 8, 0)));
        // Daily 14:00 picked long ago: today's 14:00 is still ahead.
        let later = db
            .set_reminder(&id, rule("2026-01-01", "14:00", "daily"), now(), &Paris)
            .unwrap();
        assert_eq!(later.due_at, ms(utc(2026, 11, 4, 13, 0)));
    }

    #[test]
    fn a_weekdays_reminder_dated_on_a_saturday_starts_on_monday() {
        let (db, id) = db_with_note();
        let r = db
            .set_reminder(&id, rule("2026-11-07", "14:00", "weekdays"), now(), &Paris)
            .unwrap();
        assert_eq!(
            r.due_at,
            ms(utc(2026, 11, 9, 13, 0)),
            "Monday, never that Saturday"
        );
        // Weekly keeps its own weekday when the date is in the future.
        let w = db
            .set_reminder(&id, rule("2026-11-07", "14:00", "weekly"), now(), &Paris)
            .unwrap();
        assert_eq!(w.due_at, ms(utc(2026, 11, 7, 13, 0)));
    }

    #[test]
    fn a_reminder_more_than_100_years_away_is_refused() {
        let (db, id) = db_with_note();
        for r in [
            rule("2200-01-01", "09:00", "none"),
            rule("9999-12-31", "09:00", "daily"),
        ] {
            let err = db.set_reminder(&id, r, now(), &Paris).unwrap_err();
            assert_eq!(err.code(), "validation");
            assert!(err.to_string().contains(FAR_REMINDER), "{err}");
            assert_eq!(FAR_REMINDER, "This reminder is too far away.");
        }
        // 99 years is fine.
        db.set_reminder(&id, rule("2125-01-01", "09:00", "none"), now(), &Paris)
            .unwrap();
    }

    #[test]
    fn unknown_and_trashed_notes_are_refused() {
        let (db, id) = db_with_note();
        let err = db
            .set_reminder(
                "2f1c8f0e-6a8b-4c51-9d4e-2b8f5f1a9c3d",
                rule("2026-11-04", "14:00", "none"),
                now(),
                &Paris,
            )
            .unwrap_err();
        assert_eq!(err.code(), "not_found");
        db.trash_note(&id).unwrap();
        let err = db
            .set_reminder(&id, rule("2026-11-04", "14:00", "none"), now(), &Paris)
            .unwrap_err();
        assert_eq!(err.code(), "not_allowed");
        assert_eq!(
            db.snooze_reminder(&id, Snooze::Hour1, now(), &Paris)
                .unwrap_err()
                .code(),
            "not_found"
        );
        assert_eq!(
            db.dismiss_reminder(&id, now(), &Paris).unwrap_err().code(),
            "not_found"
        );
    }

    #[test]
    fn setting_a_reminder_clears_snooze_and_fired_mark() {
        let (db, id) = db_with_note();
        let r = set_one_off(&db, &id);
        db.mark_fired(&id, r.due_at).unwrap();
        db.snooze_reminder(&id, Snooze::Hour1, utc(2026, 11, 4, 13, 5), &Paris)
            .unwrap();
        let fresh = db
            .set_reminder(&id, rule("2026-11-06", "08:00", "none"), now(), &Paris)
            .unwrap();
        assert_eq!((fresh.snoozed_until, fresh.fired_at), (None, None));
        assert_eq!(db.reminder(&id).unwrap().unwrap(), fresh);
    }

    #[test]
    fn catch_up_fires_each_occurrence_once() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("desknotes.db");
        let backups = dir.path().join("backups");
        let due = ms(utc(2026, 11, 4, 13, 0));
        let id = {
            let db = Database::open(&path, &backups).unwrap();
            let id = db.create_note(None).unwrap().id;
            set_one_off(&db, &id);
            // Not due yet.
            assert!(db.due_reminders(now(), &Paris).unwrap().is_empty());
            id
        };
        // DeskNotes was closed at the due time and starts again at 16:00 UTC.
        let start = utc(2026, 11, 4, 15, 0);
        {
            let db = Database::open(&path, &backups).unwrap();
            let due_now = db.due_reminders(start, &Paris).unwrap();
            assert_eq!(due_now.len(), 1);
            assert_eq!(due_now[0].note_id, id);
            db.mark_fired(&id, due_now[0].effective_due()).unwrap();
            assert!(db.due_reminders(start, &Paris).unwrap().is_empty());
        }
        // A second restart does not fire it again; the row stays overdue and visible.
        let db = Database::open(&path, &backups).unwrap();
        let later = utc(2026, 11, 4, 18, 0);
        assert!(db.due_reminders(later, &Paris).unwrap().is_empty());
        let rows = db.list_reminders("", later).unwrap();
        assert_eq!(rows.len(), 1);
        assert!(rows[0].overdue);
        assert_eq!(db.reminder(&id).unwrap().unwrap().fired_at, Some(due));

        // A repeat moves on when dismissed and then fires for its next occurrence only.
        let daily = db.create_note(None).unwrap().id;
        db.set_reminder(&daily, rule("2026-11-04", "14:00", "daily"), now(), &Paris)
            .unwrap();
        let due_now = db.due_reminders(later, &Paris).unwrap();
        assert_eq!(due_now.len(), 1);
        db.mark_fired(&daily, due_now[0].effective_due()).unwrap();
        db.dismiss_reminder(&daily, later, &Paris).unwrap();
        assert!(db.due_reminders(later, &Paris).unwrap().is_empty());
        let tomorrow = utc(2026, 11, 5, 13, 0);
        let again = db.due_reminders(tomorrow, &Paris).unwrap();
        assert!(again.iter().any(|r| r.note_id == daily));
    }

    #[test]
    fn trashed_notes_do_not_fire_and_restore_shows_overdue() {
        let (db, id) = db_with_note();
        set_one_off(&db, &id);
        let after = utc(2026, 11, 4, 13, 30);
        db.trash_note(&id).unwrap();
        assert!(
            db.due_reminders(after, &Paris).unwrap().is_empty(),
            "never fires in the trash"
        );
        assert!(
            db.list_reminders("", after).unwrap().is_empty(),
            "not listed in the trash"
        );
        assert_eq!(db.next_wake(now(), &Paris).unwrap(), None);
        assert!(db.reminder(&id).unwrap().is_some(), "the reminder is kept");

        db.restore_note(&id).unwrap();
        let rows = db.list_reminders("", after).unwrap();
        assert_eq!(rows.len(), 1);
        assert!(rows[0].overdue, "past due after restore: shown, not lost");
        assert_eq!(
            db.due_reminders(after, &Paris).unwrap().len(),
            1,
            "notified once, at last"
        );
    }

    #[test]
    fn archived_notes_still_fire_and_are_listed() {
        let (db, id) = db_with_note();
        set_one_off(&db, &id);
        db.set_archived(&id, true).unwrap();
        let after = utc(2026, 11, 4, 13, 1);
        assert_eq!(db.due_reminders(after, &Paris).unwrap().len(), 1);
        assert_eq!(db.list_reminders("", after).unwrap().len(), 1);
        assert_eq!(
            db.next_wake(now(), &Paris).unwrap(),
            Some(ms(utc(2026, 11, 4, 13, 0)))
        );
    }

    #[test]
    fn done_notes_do_not_fire() {
        let (db, id) = db_with_note();
        let r = set_one_off(&db, &id);
        db.set_completed(&id, true, ms(now())).unwrap();
        let after = utc(2026, 11, 4, 13, 30);
        assert!(
            db.due_reminders(after, &Paris).unwrap().is_empty(),
            "a reminder that falls due while the note is done never fires"
        );
        assert_eq!(db.next_wake(now(), &Paris).unwrap(), None);
        assert_eq!(db.reminder(&id).unwrap(), Some(r), "the rule is kept");

        // After Reopen the past due time is overdue and fires once.
        db.set_completed(&id, false, ms(after)).unwrap();
        let rows = db.list_reminders("", after).unwrap();
        assert_eq!(rows.len(), 1);
        assert!(rows[0].overdue);
        let due_now = db.due_reminders(after, &Paris).unwrap();
        assert_eq!(due_now.len(), 1);
        db.mark_fired(&id, due_now[0].effective_due()).unwrap();
        assert!(db.due_reminders(after, &Paris).unwrap().is_empty());
    }

    #[test]
    fn done_repeats_do_not_advance_or_wake_and_resume_after_reopen() {
        let (db, id) = db_with_note();
        db.set_reminder(&id, rule("2026-11-04", "14:00", "daily"), now(), &Paris)
            .unwrap();
        db.set_completed(&id, true, ms(now())).unwrap();
        let later = utc(2026, 11, 6, 13, 30);
        assert!(db.due_reminders(later, &Paris).unwrap().is_empty());
        assert_eq!(db.next_wake(later, &Paris).unwrap(), None);
        db.set_completed(&id, false, ms(later)).unwrap();
        assert_eq!(db.due_reminders(later, &Paris).unwrap().len(), 1);
    }

    #[test]
    fn done_notes_not_in_list_reminders() {
        let (db, id) = db_with_note();
        set_one_off(&db, &id);
        assert_eq!(db.list_reminders("", now()).unwrap().len(), 1);
        db.set_completed(&id, true, ms(now())).unwrap();
        assert!(db.list_reminders("", now()).unwrap().is_empty());
        db.set_completed(&id, false, ms(now())).unwrap();
        assert_eq!(db.list_reminders("", now()).unwrap().len(), 1);
    }

    #[test]
    fn snooze_then_the_due_list() {
        let (db, id) = db_with_note();
        let r = set_one_off(&db, &id);
        let fired_at = utc(2026, 11, 4, 13, 0);
        assert_eq!(db.due_reminders(fired_at, &Paris).unwrap().len(), 1);
        db.mark_fired(&id, r.effective_due()).unwrap();

        let s = db
            .snooze_reminder(&id, Snooze::Minutes10, fired_at, &Paris)
            .unwrap();
        assert_eq!(s.snoozed_until, Some(ms(utc(2026, 11, 4, 13, 10))));
        assert_eq!(s.due_at, r.due_at, "the anchor never moves");
        assert_eq!(s.rule, r.rule);
        assert_eq!(db.reminder(&id).unwrap().unwrap(), s);

        // Not due again until the snooze ends; then it fires once more.
        assert!(
            db.due_reminders(utc(2026, 11, 4, 13, 9), &Paris)
                .unwrap()
                .is_empty()
        );
        assert_eq!(
            db.next_wake(utc(2026, 11, 4, 13, 1), &Paris).unwrap(),
            s.snoozed_until
        );
        let due = db.due_reminders(utc(2026, 11, 4, 13, 10), &Paris).unwrap();
        assert_eq!(due.len(), 1);
        assert_eq!(due[0].effective_due(), ms(utc(2026, 11, 4, 13, 10)));
        db.mark_fired(&id, due[0].effective_due()).unwrap();
        assert!(
            db.due_reminders(utc(2026, 11, 4, 14, 0), &Paris)
                .unwrap()
                .is_empty()
        );

        // 1 h counts from now; Tomorrow is the same wall-clock time tomorrow (Paris).
        let h = db
            .snooze_reminder(&id, Snooze::Hour1, utc(2026, 11, 4, 13, 20), &Paris)
            .unwrap();
        assert_eq!(h.snoozed_until, Some(ms(utc(2026, 11, 4, 14, 20))));
        let t = db
            .snooze_reminder(&id, Snooze::Tomorrow, utc(2026, 11, 4, 13, 20), &Paris)
            .unwrap();
        assert_eq!(t.snoozed_until, Some(ms(utc(2026, 11, 5, 13, 0))));
    }

    #[test]
    fn dismiss_deletes_a_one_off_and_moves_a_repeat_on() {
        let (db, id) = db_with_note();
        set_one_off(&db, &id);
        assert_eq!(
            db.dismiss_reminder(&id, utc(2026, 11, 4, 13, 5), &Paris)
                .unwrap(),
            None
        );
        assert_eq!(db.reminder(&id).unwrap(), None);

        // Weekdays, dismissed on a Friday afternoon: Monday.
        let wk = db.create_note(None).unwrap().id;
        db.set_reminder(&wk, rule("2026-11-06", "14:00", "weekdays"), now(), &Paris)
            .unwrap();
        let friday = utc(2026, 11, 6, 13, 5);
        let r = db.reminder(&wk).unwrap().unwrap();
        db.mark_fired(&wk, r.due_at).unwrap();
        db.snooze_reminder(&wk, Snooze::Hour1, friday, &Paris)
            .unwrap();
        let next = db.dismiss_reminder(&wk, friday, &Paris).unwrap().unwrap();
        assert_eq!(next.due_at, ms(utc(2026, 11, 9, 13, 0)));
        assert_eq!((next.snoozed_until, next.fired_at), (None, None));
        assert_eq!(db.reminder(&wk).unwrap().unwrap(), next);
        assert_eq!(next.rule.repeat, Repeat::Weekdays);

        // Dismissed before it is due (from the list): skips to the occurrence after.
        let early = db
            .dismiss_reminder(&wk, utc(2026, 11, 6, 20, 0), &Paris)
            .unwrap()
            .unwrap();
        assert_eq!(early.due_at, ms(utc(2026, 11, 10, 13, 0)));
    }

    #[test]
    fn next_wake_is_the_earliest_future_effective_due() {
        let db = Database::open_in_memory().unwrap();
        assert_eq!(db.next_wake(now(), &Paris).unwrap(), None);
        let a = db.create_note(None).unwrap().id;
        let b = db.create_note(None).unwrap().id;
        let c = db.create_note(None).unwrap().id;
        db.set_reminder(&a, rule("2026-11-05", "09:00", "none"), now(), &Paris)
            .unwrap();
        db.set_reminder(&b, rule("2026-11-04", "14:00", "none"), now(), &Paris)
            .unwrap();
        db.set_reminder(&c, rule("2026-11-04", "12:00", "none"), now(), &Paris)
            .unwrap();
        assert_eq!(
            db.next_wake(now(), &Paris).unwrap(),
            Some(ms(utc(2026, 11, 4, 11, 0)))
        );
        // Once that one has passed, the next is 13:00; overdue ones are not "future".
        assert_eq!(
            db.next_wake(utc(2026, 11, 4, 11, 0), &Paris).unwrap(),
            Some(ms(utc(2026, 11, 4, 13, 0)))
        );
        // A snooze counts as the due time.
        db.snooze_reminder(&b, Snooze::Hour1, utc(2026, 11, 4, 11, 30), &Paris)
            .unwrap();
        assert_eq!(
            db.next_wake(utc(2026, 11, 4, 11, 30), &Paris).unwrap(),
            Some(ms(utc(2026, 11, 4, 12, 30)))
        );
        db.trash_note(&c).unwrap();
        db.remove_reminder(&b).unwrap();
        assert_eq!(
            db.next_wake(now(), &Paris).unwrap(),
            Some(ms(utc(2026, 11, 5, 8, 0)))
        );
        assert_eq!(db.next_wake(utc(2026, 11, 6, 0, 0), &Paris).unwrap(), None);
    }

    #[test]
    fn mark_fired_for_a_stale_due_time_changes_nothing() {
        let (db, id) = db_with_note();
        let r = set_one_off(&db, &id);
        db.mark_fired(&id, r.due_at - 1).unwrap();
        assert_eq!(db.reminder(&id).unwrap().unwrap().fired_at, None);
        db.mark_fired("2f1c8f0e-6a8b-4c51-9d4e-2b8f5f1a9c3d", r.due_at)
            .unwrap();
    }

    #[test]
    fn list_reminders_sorts_flags_overdue_and_returns_real_titles() {
        let db = Database::open_in_memory().unwrap();
        let doc = |t: &str| {
            serde_json::json!({"type":"doc","content":[{"type":"paragraph","content":[
                {"type":"text","text":t}]}]})
            .to_string()
        };
        let a = db.create_note(Some("#c8f7c5")).unwrap().id;
        db.save_content(&a, &doc("Dentist")).unwrap();
        let b = db.create_note(None).unwrap().id;
        db.save_content(&b, &doc("Écoles à payer")).unwrap();
        let c = db.create_note(None).unwrap().id;
        db.save_content(&c, &doc("Bank")).unwrap();
        db.set_private(&c, true, "Money").unwrap();
        let gone = db.create_note(None).unwrap().id;
        db.save_content(&gone, &doc("Dentist trash")).unwrap();

        db.set_reminder(&a, rule("2026-11-06", "10:00", "weekly"), now(), &Paris)
            .unwrap();
        db.set_reminder(&b, rule("2026-11-04", "11:30", "none"), now(), &Paris)
            .unwrap();
        db.set_reminder(&c, rule("2026-11-04", "15:00", "none"), now(), &Paris)
            .unwrap();
        db.set_reminder(&gone, rule("2026-11-04", "12:00", "none"), now(), &Paris)
            .unwrap();
        db.trash_note(&gone).unwrap();

        let at_noon = utc(2026, 11, 4, 11, 0); // 12:00 Paris: b (11:30) has passed
        let rows = db.list_reminders("", at_noon).unwrap();
        let ids: Vec<_> = rows.iter().map(|r| r.note_id.as_str()).collect();
        assert_eq!(
            ids,
            [b.as_str(), c.as_str(), a.as_str()],
            "by effective due, no trash"
        );
        assert!(rows[0].overdue && !rows[1].overdue && !rows[2].overdue);
        assert_eq!(rows[0].title, "Écoles à payer");
        assert_eq!(rows[0].repeat, Repeat::None);
        assert_eq!(rows[2].repeat, Repeat::Weekly);
        assert_eq!(rows[2].color, "#c8f7c5");
        assert_eq!(rows[2].effective_due, ms(utc(2026, 11, 6, 9, 0)));
        assert!(rows[1].private && !rows[0].private);
        assert_eq!(
            rows[1].title, "Bank",
            "the real title: the shell masks it (R1)"
        );

        // Title search: case-insensitive and Unicode-aware.
        let hit = |q: &str| -> Vec<String> {
            db.list_reminders(q, at_noon)
                .unwrap()
                .into_iter()
                .map(|r| r.note_id)
                .collect()
        };
        assert_eq!(hit("DENT"), vec![a.clone()]);
        assert_eq!(hit("  écoles "), vec![b.clone()]);
        assert_eq!(hit("ÉCOLES"), vec![b.clone()]);
        assert!(hit("zzz").is_empty());
        assert_eq!(hit("   ").len(), 3, "blank query lists everything");
        assert_eq!(hit("bank"), vec![c.clone()]);

        // While locked, searching cannot probe the hidden title; the label matches.
        db.set_new_pin("482913").unwrap();
        db.set_privacy_locked(true, &[]);
        assert!(hit("bank").is_empty());
        assert_eq!(hit("money"), vec![c.clone()]);
        let locked_rows = db.list_reminders("", at_noon).unwrap();
        assert_eq!(locked_rows.len(), 3);
        let locked_flags: Vec<_> = locked_rows
            .iter()
            .map(|r| (r.note_id.clone(), r.locked))
            .collect();
        assert_eq!(
            locked_flags,
            [(b.clone(), false), (c.clone(), true), (a.clone(), false)]
        );
        // A private note kept open across the lock is searched by title and not masked.
        db.set_privacy_locked(false, &[]);
        db.set_privacy_locked(true, std::slice::from_ref(&c));
        assert!(
            db.list_reminders("", at_noon)
                .unwrap()
                .iter()
                .all(|r| !r.locked)
        );
        assert_eq!(hit("bank"), vec![c.clone()]);
        db.set_privacy_locked(true, &[]);
        assert!(
            db.list_reminders("", at_noon)
                .unwrap()
                .iter()
                .any(|r| r.locked)
        );
        db.set_privacy_locked(false, &[]);
        assert!(
            db.list_reminders("", at_noon)
                .unwrap()
                .iter()
                .all(|r| !r.locked)
        );
    }

    #[test]
    fn list_reminders_flags_archived_notes() {
        let (db, id) = db_with_note();
        set_one_off(&db, &id);
        let flags = |db: &Database| -> Vec<bool> {
            db.list_reminders("", now())
                .unwrap()
                .iter()
                .map(|r| r.archived)
                .collect()
        };
        assert_eq!(flags(&db), [false]);
        db.set_archived(&id, true).unwrap();
        assert_eq!(flags(&db), [true], "archived notes stay listed, flagged");
        db.set_archived(&id, false).unwrap();
        assert_eq!(flags(&db), [false]);
    }

    #[test]
    fn a_damaged_row_is_treated_as_absent_and_can_be_replaced() {
        let (db, id) = db_with_note();
        let good = db.create_note(None).unwrap().id;
        set_one_off(&db, &id);
        db.set_reminder(&good, rule("2026-11-04", "15:00", "none"), now(), &Paris)
            .unwrap();
        let after = utc(2026, 11, 4, 13, 30);
        for damage in [
            "UPDATE reminders SET local_date = '2026-02-30' WHERE note_id = ?1",
            "UPDATE reminders SET repeat = 'hourly' WHERE note_id = ?1",
            "UPDATE reminders SET local_time = '25:61' WHERE note_id = ?1",
            "UPDATE reminders SET due_at = 9223372036854775807 WHERE note_id = ?1",
            "UPDATE reminders SET due_at = 'soon' WHERE note_id = ?1",
        ] {
            db.conn
                .execute("DELETE FROM reminders WHERE note_id = ?1", [&id])
                .unwrap();
            db.conn
                .execute(
                    "INSERT INTO reminders VALUES (?1, '2026-11-04', '14:00', 'none', 1793797200000, NULL, NULL)",
                    [&id],
                )
                .unwrap();
            db.conn.execute(damage, [&id]).unwrap();
            assert_eq!(db.reminder(&id).unwrap(), None, "{damage}");
            assert_eq!(
                db.due_reminders(after, &Paris).unwrap().len(),
                0,
                "{damage}: only the good one is not due yet"
            );
            let rows = db.list_reminders("", after).unwrap();
            assert_eq!(rows.len(), 1, "{damage}");
            assert_eq!(rows[0].note_id, good);
            assert_eq!(
                db.next_wake(after, &Paris).unwrap(),
                Some(ms(utc(2026, 11, 4, 14, 0)))
            );
            assert_eq!(
                db.snooze_reminder(&id, Snooze::Hour1, after, &Paris)
                    .unwrap_err()
                    .code(),
                "not_found"
            );
            // The user can set a fresh one over it.
            let fresh = db
                .set_reminder(&id, rule("2026-11-05", "09:00", "none"), now(), &Paris)
                .unwrap();
            assert_eq!(db.reminder(&id).unwrap(), Some(fresh));
        }
    }

    #[test]
    fn reminders_survive_reopening_the_database_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("desknotes.db");
        let (id, set) = {
            let db = Database::open(&path, &dir.path().join("b")).unwrap();
            let id = db.create_note(None).unwrap().id;
            let set = db
                .set_reminder(&id, rule("2026-11-04", "14:00", "monthly"), now(), &Paris)
                .unwrap();
            (id, set)
        };
        let db = Database::open(&path, &dir.path().join("b")).unwrap();
        assert_eq!(db.reminder(&id).unwrap(), Some(set));
    }

    // ---- R5: a fired, un-dismissed repeat moves on by itself ----

    /// Monday 2 Nov 2026, 07:00 Paris: before a Daily 09:00 (08:00 UTC) reminder's first time.
    fn monday_morning() -> DateTime<Utc> {
        utc(2026, 11, 2, 6, 0)
    }

    #[test]
    fn a_fired_unanswered_daily_fires_again_the_next_day_once() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("desknotes.db");
        let backups = dir.path().join("backups");
        let id = {
            let db = Database::open(&path, &backups).unwrap();
            let id = db.create_note(None).unwrap().id;
            db.set_reminder(
                &id,
                rule("2026-11-02", "09:00", "daily"),
                monday_morning(),
                &Paris,
            )
            .unwrap();
            // Monday 09:00: fires and is closed without an answer.
            let mon = utc(2026, 11, 2, 8, 0);
            let due = db.due_reminders(mon, &Paris).unwrap();
            assert_eq!(due.len(), 1);
            db.mark_fired(&id, due[0].effective_due()).unwrap();
            assert!(db.due_reminders(mon, &Paris).unwrap().is_empty());
            // It is not forgotten: the scheduler wakes for tomorrow 09:00.
            assert_eq!(
                db.next_wake(utc(2026, 11, 2, 8, 1), &Paris).unwrap(),
                Some(ms(utc(2026, 11, 3, 8, 0)))
            );
            id
        };
        let db = Database::open(&path, &backups).unwrap();
        assert!(
            db.due_reminders(utc(2026, 11, 3, 7, 59), &Paris)
                .unwrap()
                .is_empty()
        );
        let tue = utc(2026, 11, 3, 8, 0);
        let due = db.due_reminders(tue, &Paris).unwrap();
        assert_eq!(due.len(), 1, "fires again on Tuesday");
        assert_eq!(due[0].effective_due(), ms(tue));
        db.mark_fired(&id, due[0].effective_due()).unwrap();
        assert!(
            db.due_reminders(utc(2026, 11, 3, 12, 0), &Paris)
                .unwrap()
                .is_empty()
        );
        assert_eq!(
            db.next_wake(utc(2026, 11, 3, 12, 0), &Paris).unwrap(),
            Some(ms(utc(2026, 11, 4, 8, 0)))
        );
        // Still listed as overdue for the latest occurrence.
        let rows = db.list_reminders("", utc(2026, 11, 3, 12, 0)).unwrap();
        assert!(rows[0].overdue);
        assert_eq!(rows[0].effective_due, ms(tue));
        drop(db);
        let db = Database::open(&path, &backups).unwrap();
        assert!(
            db.due_reminders(utc(2026, 11, 3, 13, 0), &Paris)
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn a_fired_weekdays_reminder_next_wakes_on_monday() {
        let (db, id) = db_with_note();
        let thursday = utc(2026, 11, 5, 10, 0);
        db.set_reminder(
            &id,
            rule("2026-11-06", "14:00", "weekdays"),
            thursday,
            &Paris,
        )
        .unwrap();
        let fri = utc(2026, 11, 6, 13, 0);
        let due = db.due_reminders(fri, &Paris).unwrap();
        assert_eq!(due.len(), 1);
        db.mark_fired(&id, due[0].effective_due()).unwrap();
        assert_eq!(
            db.next_wake(utc(2026, 11, 6, 13, 1), &Paris).unwrap(),
            Some(ms(utc(2026, 11, 9, 13, 0)))
        );
        // Saturday and Sunday stay silent; Monday fires.
        assert!(
            db.due_reminders(utc(2026, 11, 8, 20, 0), &Paris)
                .unwrap()
                .is_empty()
        );
        assert_eq!(
            db.due_reminders(utc(2026, 11, 9, 13, 0), &Paris)
                .unwrap()
                .len(),
            1
        );
    }

    #[test]
    fn a_repeat_missed_for_three_days_fires_once_for_the_latest_occurrence() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("desknotes.db");
        let backups = dir.path().join("backups");
        let id = {
            let db = Database::open(&path, &backups).unwrap();
            let id = db.create_note(None).unwrap().id;
            db.set_reminder(
                &id,
                rule("2026-11-02", "09:00", "daily"),
                monday_morning(),
                &Paris,
            )
            .unwrap();
            id
        };
        // Closed Mon-Wed; reopened Thursday 11:00 Paris (Mon, Tue, Wed and Thu 09:00 passed).
        let db = Database::open(&path, &backups).unwrap();
        let thu = utc(2026, 11, 5, 10, 0);
        let due = db.due_reminders(thu, &Paris).unwrap();
        assert_eq!(due.len(), 1, "once, not four times");
        assert_eq!(due[0].effective_due(), ms(utc(2026, 11, 5, 8, 0)));
        assert_eq!(due[0].fired_at, None);
        db.mark_fired(&id, due[0].effective_due()).unwrap();
        assert!(db.due_reminders(thu, &Paris).unwrap().is_empty());
        assert_eq!(
            db.next_wake(thu, &Paris).unwrap(),
            Some(ms(utc(2026, 11, 6, 8, 0)))
        );
        let rows = db.list_reminders("", thu).unwrap();
        assert!(rows[0].overdue && rows[0].effective_due == ms(utc(2026, 11, 5, 8, 0)));
    }

    #[test]
    fn advancing_a_repeat_clears_its_snooze_and_skips_trashed_notes() {
        let (db, id) = db_with_note();
        let trashed = db.create_note(None).unwrap().id;
        for n in [&id, &trashed] {
            db.set_reminder(
                n,
                rule("2026-11-02", "09:00", "daily"),
                monday_morning(),
                &Paris,
            )
            .unwrap();
        }
        let mon = utc(2026, 11, 2, 8, 0);
        db.mark_fired(&id, ms(mon)).unwrap();
        db.snooze_reminder(&id, Snooze::Hour1, mon, &Paris).unwrap();
        db.trash_note(&trashed).unwrap();
        let tue = utc(2026, 11, 3, 8, 0);
        let due = db.due_reminders(tue, &Paris).unwrap();
        assert_eq!(due.len(), 1);
        assert_eq!(due[0].snoozed_until, None, "the snooze belonged to Monday");
        assert_eq!(due[0].due_at, ms(tue));
        // The trashed note's row was not advanced.
        assert_eq!(db.reminder(&trashed).unwrap().unwrap().due_at, ms(mon));
        // A pending snooze that has not been outlived is left alone.
        let (db2, id2) = db_with_note();
        db2.set_reminder(
            &id2,
            rule("2026-11-02", "09:00", "daily"),
            monday_morning(),
            &Paris,
        )
        .unwrap();
        db2.mark_fired(&id2, ms(mon)).unwrap();
        db2.snooze_reminder(&id2, Snooze::Tomorrow, mon, &Paris)
            .unwrap();
        assert!(
            db2.due_reminders(utc(2026, 11, 3, 7, 59), &Paris)
                .unwrap()
                .is_empty()
        );
        let at = db2.due_reminders(tue, &Paris).unwrap();
        assert_eq!(at.len(), 1, "the Tomorrow snooze fires once at 09:00");
        assert_eq!(at[0].effective_due(), ms(tue));
    }

    #[test]
    fn a_fired_one_off_stays_overdue_and_silent() {
        let (db, id) = db_with_note();
        let r = set_one_off(&db, &id);
        db.mark_fired(&id, r.due_at).unwrap();
        let later = utc(2026, 11, 9, 0, 0);
        assert!(db.due_reminders(later, &Paris).unwrap().is_empty());
        assert_eq!(db.next_wake(later, &Paris).unwrap(), None);
        assert_eq!(db.reminder(&id).unwrap().unwrap().due_at, r.due_at);
        assert!(db.list_reminders("", later).unwrap()[0].overdue);
    }

    // ---- R4: re-anchor after a time-zone change ----

    #[test]
    fn reanchor_keeps_the_wall_clock_time_in_a_new_zone() {
        use chrono_tz::America::New_York;
        use chrono_tz::Pacific::Auckland;

        let db = Database::open_in_memory().unwrap();
        let daily = db.create_note(None).unwrap().id;
        let once = db.create_note(None).unwrap().id;
        let fired = db.create_note(None).unwrap().id;
        let snoozed = db.create_note(None).unwrap().id;
        let trashed_note = db.create_note(None).unwrap().id;
        let past_repeat = db.create_note(None).unwrap().id;
        for n in [&daily, &fired, &snoozed, &trashed_note] {
            db.set_reminder(n, rule("2026-11-04", "14:00", "daily"), now(), &Paris)
                .unwrap();
        }
        db.set_reminder(&once, rule("2026-11-04", "14:00", "none"), now(), &Paris)
            .unwrap();
        db.set_reminder(
            &past_repeat,
            rule("2026-11-04", "09:00", "daily"),
            now(),
            &Paris,
        )
        .unwrap(); // next 09:00 Paris is tomorrow
        let fired_due = db.reminder(&fired).unwrap().unwrap().due_at;
        db.mark_fired(&fired, fired_due).unwrap();
        db.snooze_reminder(&snoozed, Snooze::Hour1, now(), &Paris)
            .unwrap();
        let snoozed_before = db.reminder(&snoozed).unwrap().unwrap();
        db.trash_note(&trashed_note).unwrap();
        // A damaged row is skipped, not an error.
        let damaged = db.create_note(None).unwrap().id;
        db.conn
            .execute(
                "INSERT INTO reminders VALUES (?1, 'nope', '14:00', 'none', 1793797200000, NULL, NULL)",
                [&damaged],
            )
            .unwrap();

        let changed = db.reanchor_reminders(now(), &New_York).unwrap();
        let ny_14 = ms(utc(2026, 11, 4, 19, 0)); // 14:00 EST
        assert_eq!(db.reminder(&daily).unwrap().unwrap().due_at, ny_14);
        assert_eq!(db.reminder(&once).unwrap().unwrap().due_at, ny_14);
        assert_eq!(
            db.reminder(&trashed_note).unwrap().unwrap().due_at,
            ny_14,
            "a trashed note is re-anchored too, so a restore is right"
        );
        // 09:00 Paris tomorrow becomes the next 09:00 in New York (14:00 UTC today, still ahead).
        assert_eq!(
            db.reminder(&past_repeat).unwrap().unwrap().due_at,
            ms(utc(2026, 11, 4, 14, 0))
        );
        assert_eq!(changed, 4);
        // Fired and snoozed rows are untouched.
        assert_eq!(db.reminder(&fired).unwrap().unwrap().due_at, fired_due);
        assert_eq!(db.reminder(&snoozed).unwrap().unwrap(), snoozed_before);
        // Running it again changes nothing.
        assert_eq!(db.reanchor_reminders(now(), &New_York).unwrap(), 0);

        // A one-off may become overdue in a zone ahead of the old one; it is kept.
        db.set_reminder(&once, rule("2026-11-04", "14:00", "none"), now(), &Paris)
            .unwrap();
        db.reanchor_reminders(now(), &Auckland).unwrap();
        let o = db.reminder(&once).unwrap().unwrap();
        assert_eq!(o.due_at, ms(utc(2026, 11, 4, 1, 0)), "14:00 NZDT");
        assert!(
            db.due_reminders(now(), &Auckland)
                .unwrap()
                .iter()
                .any(|r| r.note_id == once)
        );
    }

    #[test]
    fn a_past_due_one_off_moves_later_when_the_zone_moves_west() {
        use chrono_tz::America::New_York;
        // 14:00 Paris (13:00 UTC) went by at 13:30 UTC without firing (the app was busy).
        let (db, id) = db_with_note();
        db.set_reminder(&id, rule("2026-11-04", "14:00", "none"), now(), &Paris)
            .unwrap();
        let late = utc(2026, 11, 4, 13, 30);
        assert!(
            db.due_reminders(late, &Paris)
                .unwrap()
                .iter()
                .any(|r| r.note_id == id)
        );
        // The computer moves to New York, where it is 08:30: the wall-clock rule keeps
        // 14:00, now 14:00 New York (19:00 UTC). It is no longer due; it fires then.
        assert_eq!(db.reanchor_reminders(late, &New_York).unwrap(), 1);
        assert_eq!(
            db.reminder(&id).unwrap().unwrap().due_at,
            ms(utc(2026, 11, 4, 19, 0))
        );
        assert!(db.due_reminders(late, &New_York).unwrap().is_empty());
    }

    // ---- R7: trashed notes ----

    #[test]
    fn snooze_and_dismiss_are_refused_on_a_trashed_note() {
        let (db, id) = db_with_note();
        let r = set_one_off(&db, &id);
        db.trash_note(&id).unwrap();
        let err = db
            .snooze_reminder(&id, Snooze::Hour1, now(), &Paris)
            .unwrap_err();
        assert_eq!(err.code(), "not_allowed");
        let err = db.dismiss_reminder(&id, now(), &Paris).unwrap_err();
        assert_eq!(err.code(), "not_allowed");
        assert_eq!(db.reminder(&id).unwrap(), Some(r), "unchanged");
        db.restore_note(&id).unwrap();
        db.snooze_reminder(&id, Snooze::Hour1, now(), &Paris)
            .unwrap();
    }

    // ---- Notification heading (ruling R6) ----

    #[test]
    fn reminder_heading_gives_the_title_and_the_locked_flag() {
        let db = Database::open_in_memory().unwrap();
        let id = db.create_note(None).unwrap().id;
        let doc = serde_json::json!({"type":"doc","content":[{"type":"paragraph","content":[
            {"type":"text","text":"Bank"}]}]})
        .to_string();
        db.save_content(&id, &doc).unwrap();
        let heading = |db: &Database| db.reminder_heading(&id).unwrap().unwrap();
        assert_eq!(
            heading(&db),
            ReminderHeading {
                title: "Bank".into(),
                locked: false
            }
        );

        db.set_private(&id, true, "Money").unwrap();
        assert!(!heading(&db).locked, "private but not locked");
        db.set_new_pin("482913").unwrap();
        db.set_privacy_locked(true, &[]);
        assert!(heading(&db).locked, "the same rule as list_reminders");
        db.set_privacy_locked(false, &[]);
        db.set_privacy_locked(true, std::slice::from_ref(&id));
        assert!(!heading(&db).locked, "kept open across the lock");

        assert_eq!(
            db.reminder_heading("2f1c8f0e-6a8b-4c51-9d4e-2b8f5f1a9c3d")
                .unwrap(),
            None
        );
    }
}
