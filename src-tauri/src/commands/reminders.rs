//! Reminder commands (spec §3.1, §3.5). The core validates the date, time and repeat
//! and owns every time rule; these commands pass the current time and the computer's
//! time zone, and after any change tell every window (`reminders-changed`, no titles)
//! and wake the scheduler.

use chrono::{DateTime, Local, TimeZone, Utc};
use desknotes_core::reminders::{
    FAR_REMINDER, PAST_REMINDER, Reminder, ReminderRow, Repeat, validate_rule,
};
use desknotes_core::validation::parse_note_id;
use desknotes_core::{CoreError, CoreResult, Database};
use serde::Serialize;
use tauri::{AppHandle, State};

use crate::error::{IpcError, IpcResult};
use crate::reminders::{self, masked_title};
use crate::state::AppState;

/// A note's reminder as the reminder popover and the chip need it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReminderView {
    /// The date the person picked, `YYYY-MM-DD`.
    pub date: String,
    /// The time the person picked, `HH:MM` (24 h).
    pub time: String,
    pub repeat: Repeat,
    /// When it is next due (UTC ms): the snooze if there is one, else the occurrence.
    pub due_at: i64,
    pub overdue: bool,
}

/// One row of the manager's Reminders tab. `title` is already "Private note" while
/// the lock withholds the note (ruling R6).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReminderListRow {
    pub note_id: String,
    pub title: String,
    pub color: String,
    pub repeat: Repeat,
    pub due_at: i64,
    pub overdue: bool,
    pub locked: bool,
    /// The note is archived (no window): the manager opens its Archived tab (R17).
    pub archived: bool,
}

/// The core's refusals for a time in the past or too far away are shown verbatim,
/// without the "invalid data: " prefix (ruling R7); every other error as usual.
pub(crate) fn reminder_error(e: CoreError) -> IpcError {
    match &e {
        CoreError::Validation(m) if m == PAST_REMINDER || m == FAR_REMINDER => {
            IpcError::new(e.code(), m.clone())
        }
        _ => e.into(),
    }
}

fn view(r: &Reminder, now: DateTime<Utc>) -> ReminderView {
    let due_at = r.effective_due();
    ReminderView {
        date: r.rule.local_date.format("%Y-%m-%d").to_string(),
        time: r.rule.local_time.format("%H:%M").to_string(),
        repeat: r.rule.repeat,
        due_at,
        overdue: due_at <= now.timestamp_millis(),
    }
}

fn get_in(db: &Database, note_id: &str, now: DateTime<Utc>) -> CoreResult<Option<ReminderView>> {
    Ok(db.reminder(note_id)?.map(|r| view(&r, now)))
}

fn set_in<Tz: TimeZone>(
    db: &Database,
    note_id: &str,
    date: &str,
    time: &str,
    repeat: &str,
    now: DateTime<Utc>,
    tz: &Tz,
) -> CoreResult<ReminderView> {
    let rule = validate_rule(date, time, repeat)?;
    let set = db.set_reminder(note_id, rule, now, tz)?;
    Ok(view(&set, now))
}

fn list_row(r: ReminderRow) -> ReminderListRow {
    ReminderListRow {
        title: masked_title(&r.title, r.locked).to_owned(),
        note_id: r.note_id,
        color: r.color,
        repeat: r.repeat,
        due_at: r.effective_due,
        overdue: r.overdue,
        locked: r.locked,
        archived: r.archived,
    }
}

fn list_in(db: &Database, query: &str, now: DateTime<Utc>) -> CoreResult<Vec<ReminderListRow>> {
    Ok(db
        .list_reminders(query, now)?
        .into_iter()
        .map(list_row)
        .collect())
}

/// The note's reminder, or `null` when it has none.
#[tauri::command]
pub fn get_reminder(
    state: State<'_, AppState>,
    note_id: String,
) -> IpcResult<Option<ReminderView>> {
    let id = parse_note_id(&note_id)?;
    state.with_db(|db| get_in(db, &id, Utc::now()))
}

/// Give the note a reminder, replacing any earlier one. A one-off in the past is
/// refused with "Pick a time in the future.".
#[tauri::command]
pub fn set_reminder(
    app: AppHandle,
    state: State<'_, AppState>,
    note_id: String,
    date: String,
    time: String,
    repeat: String,
) -> IpcResult<ReminderView> {
    let id = parse_note_id(&note_id)?;
    let set = state
        .with_db(|db| Ok(set_in(db, &id, &date, &time, &repeat, Utc::now(), &Local)))?
        .map_err(reminder_error)?;
    reminders::changed(&app, Some(&id));
    Ok(set)
}

#[tauri::command]
pub fn remove_reminder(
    app: AppHandle,
    state: State<'_, AppState>,
    note_id: String,
) -> IpcResult<()> {
    let id = parse_note_id(&note_id)?;
    state.with_db(|db| db.remove_reminder(&id))?;
    reminders::changed(&app, Some(&id));
    Ok(())
}

/// Every reminder on a note that is not in the trash, earliest first, filtered by
/// title (by the neutral label while a private note is locked).
#[tauri::command]
pub fn list_reminders(
    state: State<'_, AppState>,
    query: Option<String>,
) -> IpcResult<Vec<ReminderListRow>> {
    state.with_db(|db| list_in(db, query.as_deref().unwrap_or(""), Utc::now()))
}

#[cfg(test)]
mod tests {
    use chrono_tz::Europe::Paris;

    use super::*;

    fn utc(y: i32, mo: u32, d: u32, h: u32, mi: u32) -> DateTime<Utc> {
        Utc.with_ymd_and_hms(y, mo, d, h, mi, 0).unwrap()
    }

    /// Wednesday 4 Nov 2026, 11:00 in Paris.
    fn now() -> DateTime<Utc> {
        utc(2026, 11, 4, 10, 0)
    }

    fn db_with_note(title: &str) -> (Database, String) {
        let db = Database::open_in_memory().unwrap();
        let id = db.create_note(None).unwrap().id;
        let doc = serde_json::json!({"type":"doc","content":[{"type":"paragraph","content":[
            {"type":"text","text":title}]}]});
        db.save_content(&id, &doc.to_string()).unwrap();
        (db, id)
    }

    fn set(
        db: &Database,
        id: &str,
        date: &str,
        time: &str,
        repeat: &str,
    ) -> IpcResult<ReminderView> {
        set_in(db, id, date, time, repeat, now(), &Paris).map_err(reminder_error)
    }

    #[test]
    fn set_get_and_remove() {
        let (db, id) = db_with_note("Dentist");
        assert_eq!(get_in(&db, &id, now()).unwrap(), None);
        let v = set(&db, &id, "2026-11-04", "14:00", "weekdays").unwrap();
        let expected = ReminderView {
            date: "2026-11-04".into(),
            time: "14:00".into(),
            repeat: Repeat::Weekdays,
            due_at: utc(2026, 11, 4, 13, 0).timestamp_millis(),
            overdue: false,
        };
        assert_eq!(v, expected);
        assert_eq!(get_in(&db, &id, now()).unwrap(), Some(expected.clone()));
        // Later than the due time it reads as overdue.
        let later = get_in(&db, &id, utc(2026, 11, 4, 13, 0)).unwrap().unwrap();
        assert!(later.overdue);
        db.remove_reminder(&id).unwrap();
        assert_eq!(get_in(&db, &id, now()).unwrap(), None);
    }

    #[test]
    fn the_view_serialises_in_camel_case() {
        let (db, id) = db_with_note("Dentist");
        let v = set(&db, &id, "2026-11-04", "14:00", "none").unwrap();
        let json = serde_json::to_value(&v).unwrap();
        assert_eq!(
            json,
            serde_json::json!({"date":"2026-11-04","time":"14:00","repeat":"none",
                "dueAt": utc(2026, 11, 4, 13, 0).timestamp_millis(), "overdue": false})
        );
    }

    #[test]
    fn refusals_are_shown_verbatim() {
        let (db, id) = db_with_note("Dentist");
        let err = set(&db, &id, "2026-11-04", "09:00", "none").unwrap_err();
        assert_eq!(
            (err.code.as_str(), err.message.as_str()),
            ("validation", "Pick a time in the future.")
        );
        let err = set(&db, &id, "2199-01-01", "09:00", "none").unwrap_err();
        assert_eq!(
            (err.code.as_str(), err.message.as_str()),
            ("validation", "This reminder is too far away.")
        );
        // A past time with a repeat is fine (it starts at its next occurrence).
        set(&db, &id, "2026-11-04", "09:00", "daily").unwrap();
    }

    #[test]
    fn malformed_values_are_refused_by_the_core() {
        let (db, id) = db_with_note("Dentist");
        for (date, time, repeat) in [
            ("2026-13-01", "09:00", "none"),
            ("04/11/2026", "09:00", "none"),
            ("2026-11-04", "9:00", "none"),
            ("2026-11-04", "24:00", "none"),
            ("2026-11-04", "14:00", "yearly"),
            ("2026-11-04", "14:00", "Daily"),
        ] {
            let err = set(&db, &id, date, time, repeat).unwrap_err();
            assert_eq!(err.code, "validation", "{date} {time} {repeat}");
            assert!(err.message.starts_with("invalid data: "), "{}", err.message);
        }
        assert_eq!(get_in(&db, &id, now()).unwrap(), None, "nothing stored");
    }

    #[test]
    fn other_errors_keep_their_code() {
        assert_eq!(
            reminder_error(CoreError::NotFound("x".into())).code,
            "not_found"
        );
        let e = reminder_error(CoreError::Validation("note id must be a UUID".into()));
        assert_eq!(e.message, "invalid data: note id must be a UUID");
        let (db, id) = db_with_note("Dentist");
        db.trash_note(&id).unwrap();
        assert_eq!(
            set(&db, &id, "2026-11-04", "14:00", "none")
                .unwrap_err()
                .code,
            "not_allowed"
        );
    }

    #[test]
    fn list_masks_locked_titles_only() {
        let (db, open) = db_with_note("Dentist");
        let private = db.create_note(Some("#ffd6e0")).unwrap().id;
        let doc = serde_json::json!({"type":"doc","content":[{"type":"paragraph","content":[
            {"type":"text","text":"Bank PIN 4417"}]}]});
        db.save_content(&private, &doc.to_string()).unwrap();
        db.set_private(&private, true, "Money").unwrap();
        set(&db, &open, "2026-11-04", "14:00", "none").unwrap();
        set(&db, &private, "2026-11-04", "15:00", "daily").unwrap();

        let rows = list_in(&db, "", now()).unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!((rows[0].title.as_str(), rows[0].locked), ("Dentist", false));
        assert_eq!(
            (rows[1].title.as_str(), rows[1].locked),
            ("Bank PIN 4417", false)
        );
        assert_eq!(rows[1].color, "#ffd6e0");
        assert_eq!(rows[1].repeat, Repeat::Daily);
        assert_eq!(rows[1].due_at, utc(2026, 11, 4, 14, 0).timestamp_millis());

        db.set_new_pin("482913").unwrap();
        db.set_privacy_locked(true, &[]);
        let rows = list_in(&db, "", now()).unwrap();
        assert_eq!(
            (rows[1].title.as_str(), rows[1].locked),
            ("Private note", true)
        );
        let json = serde_json::to_string(&rows).unwrap();
        assert!(!json.contains("Bank"), "{json}");
        assert!(json.contains("\"noteId\"") && json.contains("\"dueAt\""));
        // Search cannot probe the hidden title.
        assert!(list_in(&db, "bank", now()).unwrap().is_empty());

        // An empty note is listed with an empty title; the manager shows "Empty note".
        let empty = db.create_note(None).unwrap().id;
        set(&db, &empty, "2026-11-04", "16:00", "none").unwrap();
        let rows = list_in(&db, "", now()).unwrap();
        assert_eq!(rows[2].note_id, empty);
        assert_eq!(rows[2].title, "");
    }

    #[test]
    fn list_flags_archived_notes() {
        let (db, id) = db_with_note("Dentist");
        set(&db, &id, "2026-11-04", "14:00", "none").unwrap();
        assert!(!list_in(&db, "", now()).unwrap()[0].archived);
        db.set_archived(&id, true).unwrap();
        let rows = list_in(&db, "", now()).unwrap();
        assert!(rows[0].archived);
        let json = serde_json::to_value(&rows[0]).unwrap();
        assert_eq!(json["archived"], serde_json::json!(true));
    }
}
