//! The reminder scheduler and the notification actions (spec §3.3).
//!
//! One thread waits until the next reminder is due, or 60 s at most, so a change of
//! the clock or the time zone is noticed within a minute. It also wakes at once when a
//! reminder changes, at start and when the computer resumes from sleep. On each wake
//! it re-anchors the reminders if the local UTC offset changed (ruling R4), asks the
//! core which reminders are due, sends one notification per reminder and records it as
//! fired. The core owns every time rule; this module only moves data between the core
//! and the desktop's notification service.
//!
//! Privacy: a notification shows the note's title, or "Private note" while the lock
//! withholds the note (ruling R6). Nothing here logs a title or puts one in an event.

use std::collections::HashMap;
use std::sync::{Condvar, Mutex};
use std::time::{Duration, Instant};

use chrono::{DateTime, Local, Offset, TimeZone, Utc};
use desknotes_core::reminders::{ReminderHeading, Snooze};
use desknotes_core::{CoreResult, Database, PRIVATE_FALLBACK_LABEL};
use tauri::{AppHandle, Manager};

use crate::platform::notify::{Notification, Notifier, Signal};
use crate::state::AppState;
use crate::windows;

/// At most this many reminders are sent at once after start; the rest are summed up.
pub const STARTUP_LIMIT: usize = 5;
/// The longest the scheduler sleeps, to absorb clock and time-zone changes.
pub const MAX_SLEEP: Duration = Duration::from_secs(60);
/// After the notification service failed, wait this long before trying again.
pub const RETRY_AFTER: Duration = Duration::from_secs(60);
/// What the manager and the note show for a note without text.
pub const EMPTY_TITLE: &str = "Empty note";

/// The buttons of a reminder notification, and its default action (a click on it).
pub const REMINDER_ACTIONS: &[(&str, &str)] = &[
    ("snooze10", "10 min"),
    ("snooze60", "1 h"),
    ("tomorrow", "Tomorrow"),
    ("dismiss", "Dismiss"),
    ("default", ""),
];
/// The summary of a start-up burst has no buttons; a click shows the manager.
pub const SUMMARY_ACTIONS: &[(&str, &str)] = &[("default", "")];

/// The title a reminder may show: "Private note" while the lock withholds the note
/// (ruling R6), else the real title (possibly empty). Used by the notification and the
/// manager's Reminders tab alike.
pub fn masked_title(title: &str, locked: bool) -> &str {
    if locked {
        PRIVATE_FALLBACK_LABEL
    } else {
        title
    }
}

/// What the notification shows as its summary: [`masked_title`], or "Empty note" for
/// a note without text (the manager shows that too, in its own style).
pub fn shown_title(title: &str, locked: bool) -> &str {
    match masked_title(title, locked) {
        "" => EMPTY_TITLE,
        shown => shown,
    }
}

/// The first `limit` due reminders, and how many are left over.
pub fn startup_batch<T>(due: &[T], limit: usize) -> (&[T], usize) {
    let send = due.len().min(limit);
    (&due[..send], due.len() - send)
}

/// The summary notification for the reminders left over at start. No titles.
pub fn more_summary(more: usize) -> String {
    let noun = if more == 1 { "reminder" } else { "reminders" };
    format!("{more} more {noun}")
}

/// A due reminder with what its notification may say.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DueItem {
    pub note_id: String,
    pub effective_due: i64,
    pub heading: ReminderHeading,
}

/// One notification to send, and the (note, effective due) pairs it fires.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Outgoing {
    pub summary: String,
    pub actions: &'static [(&'static str, &'static str)],
    /// The note its actions apply to; `None` for the start-up summary.
    pub note_id: Option<String>,
    pub fires: Vec<(String, i64)>,
}

/// The due reminders, oldest first, each with its note's title and locked flag.
pub fn gather<Tz: TimeZone>(
    db: &Database,
    now: DateTime<Utc>,
    tz: &Tz,
) -> CoreResult<Vec<DueItem>> {
    let mut items = Vec::new();
    for reminder in db.due_reminders(now, tz)? {
        // A note purged since the query has nothing left to remind of.
        if let Some(heading) = db.reminder_heading(&reminder.note_id)? {
            items.push(DueItem {
                effective_due: reminder.effective_due(),
                note_id: reminder.note_id,
                heading,
            });
        }
    }
    Ok(items)
}

/// The notifications for `items`: one each, or with `limit`, at most `limit` plus one
/// summary that fires the rest (so they are not sent one by one a minute later; they
/// stay overdue in the manager).
pub fn plan(items: Vec<DueItem>, limit: Option<usize>) -> Vec<Outgoing> {
    let (send, more) = startup_batch(&items, limit.unwrap_or(usize::MAX));
    let mut out: Vec<Outgoing> = send
        .iter()
        .map(|item| Outgoing {
            summary: shown_title(&item.heading.title, item.heading.locked).to_owned(),
            actions: REMINDER_ACTIONS,
            note_id: Some(item.note_id.clone()),
            fires: vec![(item.note_id.clone(), item.effective_due)],
        })
        .collect();
    if more > 0 {
        out.push(Outgoing {
            summary: more_summary(more),
            actions: SUMMARY_ACTIONS,
            note_id: None,
            fires: items[send.len()..]
                .iter()
                .map(|item| (item.note_id.clone(), item.effective_due))
                .collect(),
        });
    }
    out
}

/// What a notification button asks for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReminderAction {
    Snooze(Snooze),
    Dismiss,
    /// The notification itself was clicked: open the note.
    Open,
}

pub fn action_for_key(key: &str) -> Option<ReminderAction> {
    Some(match key {
        "snooze10" => ReminderAction::Snooze(Snooze::Minutes10),
        "snooze60" => ReminderAction::Snooze(Snooze::Hour1),
        "tomorrow" => ReminderAction::Snooze(Snooze::Tomorrow),
        "dismiss" => ReminderAction::Dismiss,
        "default" => ReminderAction::Open,
        _ => return None,
    })
}

/// Apply a snooze or a dismiss to the note's reminder. `Open` changes nothing.
pub fn apply<Tz: TimeZone>(
    db: &Database,
    note_id: &str,
    action: ReminderAction,
    now: DateTime<Utc>,
    tz: &Tz,
) -> CoreResult<()> {
    match action {
        ReminderAction::Snooze(by) => db.snooze_reminder(note_id, by, now, tz).map(drop),
        ReminderAction::Dismiss => db.dismiss_reminder(note_id, now, tz).map(drop),
        ReminderAction::Open => Ok(()),
    }
}

/// How long to sleep: until the next reminder, the end of a retry wait, or
/// [`MAX_SLEEP`], whichever comes first.
pub fn sleep_for(now_ms: i64, next_wake: Option<i64>, retry_in: Option<Duration>) -> Duration {
    let until_next = next_wake.map(|at| {
        let ms = at.saturating_sub(now_ms).max(0);
        Duration::from_millis(u64::try_from(ms).unwrap_or(0))
    });
    [Some(MAX_SLEEP), until_next, retry_in]
        .into_iter()
        .flatten()
        .min()
        .unwrap_or(MAX_SLEEP)
}

/// The scheduler's shared state (Tauri-managed).
pub struct Scheduler {
    pending: Mutex<bool>,
    woken: Condvar,
    notifier: Notifier,
    /// Notifications on screen: id → the note (`None` for the start-up summary).
    shown: Mutex<HashMap<u32, Option<String>>>,
}

impl Scheduler {
    fn wake(&self) {
        *self.pending.lock().unwrap_or_else(|e| e.into_inner()) = true;
        self.woken.notify_one();
    }

    /// Sleep for `timeout` or until woken.
    fn wait(&self, timeout: Duration) {
        let guard = self.pending.lock().unwrap_or_else(|e| e.into_inner());
        let (mut pending, _) = self
            .woken
            .wait_timeout_while(guard, timeout, |p| !*p)
            .unwrap_or_else(|e| e.into_inner());
        *pending = false;
    }
}

/// Create the scheduler and start its thread. Call once, after the state and the
/// manager exist (a click on a notification may open a note).
pub fn start(app: &AppHandle) {
    let handle = app.clone();
    app.manage(Scheduler {
        pending: Mutex::new(true),
        woken: Condvar::new(),
        notifier: Notifier::new(move |signal| on_signal(&handle, signal)),
        shown: Mutex::new(HashMap::new()),
    });
    let handle = app.clone();
    let spawned = std::thread::Builder::new()
        .name("desknotes-reminders".into())
        .spawn(move || run(&handle));
    if let Err(e) = spawned {
        eprintln!("DeskNotes: the reminder scheduler could not start: {e}");
    }
}

/// Wake the scheduler now (a reminder changed, the computer resumed, a note moved).
pub fn wake(app: &AppHandle) {
    if let Some(scheduler) = app.try_state::<Scheduler>() {
        scheduler.wake();
    }
}

/// A reminder changed: tell every window and wake the scheduler.
pub fn changed(app: &AppHandle, note_id: Option<&str>) {
    windows::emit_reminders_changed(app, note_id);
    wake(app);
}

/// What the scheduler remembers between wakes.
struct Run {
    /// The start-up burst limit applies until one pass sent everything it had.
    first: bool,
    /// The local UTC offset (seconds) at the last pass; `None` before the first.
    offset: Option<i32>,
    /// No notification is tried before this, after the service failed.
    retry_at: Option<Instant>,
    /// The last failure was logged; cleared by a success.
    failing: bool,
    /// The database could not be read at the last pass (logged once).
    unavailable: bool,
}

fn run(app: &AppHandle) {
    let mut run = Run {
        first: true,
        offset: None,
        retry_at: None,
        failing: false,
        unavailable: false,
    };
    loop {
        let timeout = pass(app, &mut run);
        app.state::<Scheduler>().wait(timeout);
    }
}

/// One wake: re-anchor if the zone changed, send what is due, and say how long to sleep.
fn pass(app: &AppHandle, run: &mut Run) -> Duration {
    let state = app.state::<AppState>();
    let scheduler = app.state::<Scheduler>();
    let now = Utc::now();
    let offset = Local::now().offset().fix().local_minus_utc();
    let mut changed = false;
    let gathered = state.with_db(|db| {
        if run.offset != Some(offset) {
            changed |= db.reanchor_reminders(now, &Local)? > 0;
        }
        gather(db, now, &Local)
    });
    let items = match gathered {
        Ok(items) => {
            run.offset = Some(offset);
            run.unavailable = false;
            items
        }
        Err(e) => {
            if !run.unavailable {
                eprintln!("DeskNotes: reminders could not be read: {}", e.code);
            }
            run.unavailable = true;
            return MAX_SLEEP;
        }
    };

    let waiting = run.retry_at.is_some_and(|at| Instant::now() < at);
    if !waiting {
        let mut all_sent = true;
        for out in plan(items, run.first.then_some(STARTUP_LIMIT)) {
            let sent = scheduler.notifier.send(&Notification {
                summary: &out.summary,
                actions: out.actions,
            });
            match sent {
                Ok(id) => {
                    lock(&scheduler.shown).insert(id, out.note_id);
                    let marked = state.with_db(|db| {
                        for (note_id, due) in &out.fires {
                            db.mark_fired(note_id, *due)?;
                        }
                        Ok(())
                    });
                    if let Err(e) = marked {
                        eprintln!(
                            "DeskNotes: a sent reminder could not be recorded: {}",
                            e.code
                        );
                    }
                    changed = true;
                }
                Err(e) => {
                    // Not marked fired: it stays due and is tried again after the wait.
                    if !run.failing {
                        eprintln!("DeskNotes: reminder notification failed: {e}");
                    }
                    run.failing = true;
                    run.retry_at = Some(Instant::now() + RETRY_AFTER);
                    all_sent = false;
                    break;
                }
            }
        }
        if all_sent {
            run.first = false;
            run.failing = false;
            run.retry_at = None;
        }
    }
    if changed {
        windows::emit_reminders_changed(app, None);
    }

    let now = Utc::now();
    let next = state.with_db(|db| db.next_wake(now, &Local)).ok().flatten();
    let retry_in = run
        .retry_at
        .map(|at| at.saturating_duration_since(Instant::now()));
    sleep_for(now.timestamp_millis(), next, retry_in)
}

/// The person clicked a button or the notification, or it closed.
fn on_signal(app: &AppHandle, signal: Signal) {
    let Some(scheduler) = app.try_state::<Scheduler>() else {
        return;
    };
    let (id, key) = match signal {
        Signal::Closed { id } => {
            lock(&scheduler.shown).remove(&id);
            return;
        }
        Signal::Action { id, key } => (id, key),
    };
    // Unknown ids belong to another app or were already answered.
    let Some(target) = lock(&scheduler.shown).remove(&id) else {
        return;
    };
    match (target, action_for_key(&key)) {
        (None, Some(ReminderAction::Open)) => {
            if let Err(e) = windows::show_manager(app) {
                eprintln!("DeskNotes: could not show the manager: {e}");
            }
        }
        (Some(note_id), Some(ReminderAction::Open)) => open_note(app, &note_id),
        (Some(note_id), Some(action)) => {
            let state = app.state::<AppState>();
            match state.with_db(|db| apply(db, &note_id, action, Utc::now(), &Local)) {
                Ok(()) => changed(app, Some(&note_id)),
                Err(e) => eprintln!("DeskNotes: reminder action failed: {}", e.code),
            }
        }
        _ => {}
    }
}

/// Open and focus the note, as the manager does. An archived note (or one trashed
/// since) has no window: the manager is shown instead, where it can be found.
fn open_note(app: &AppHandle, note_id: &str) {
    let state = app.state::<AppState>();
    if crate::commands::notes::show_note_window(app, &state, note_id).is_err()
        && let Err(e) = windows::show_manager(app)
    {
        eprintln!("DeskNotes: could not show the manager: {e}");
    }
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

#[cfg(test)]
mod tests {
    use chrono_tz::Europe::Paris;
    use desknotes_core::reminders::validate_rule;

    use super::*;

    fn utc(y: i32, mo: u32, d: u32, h: u32, mi: u32) -> DateTime<Utc> {
        Utc.with_ymd_and_hms(y, mo, d, h, mi, 0).unwrap()
    }

    /// Wednesday 4 Nov 2026, 11:00 in Paris.
    fn now() -> DateTime<Utc> {
        utc(2026, 11, 4, 10, 0)
    }

    fn doc(text: &str) -> String {
        serde_json::json!({"type":"doc","content":[{"type":"paragraph","content":[
            {"type":"text","text":text}]}]})
        .to_string()
    }

    /// A note titled `title` with a one-off reminder at 10:30 Paris today (now overdue).
    fn note_with_due_reminder(db: &Database, title: &str) -> String {
        let id = db.create_note(None).unwrap().id;
        if !title.is_empty() {
            db.save_content(&id, &doc(title)).unwrap();
        }
        let rule = validate_rule("2026-11-04", "10:30", "none").unwrap();
        db.set_reminder(&id, rule, utc(2026, 11, 4, 9, 0), &Paris)
            .unwrap();
        id
    }

    fn item(n: usize) -> DueItem {
        DueItem {
            note_id: format!("note-{n}"),
            effective_due: n as i64,
            heading: ReminderHeading {
                title: format!("Title {n}"),
                locked: false,
            },
        }
    }

    /// Every text a notification for these items would show.
    fn texts(out: &[Outgoing]) -> Vec<String> {
        out.iter()
            .flat_map(|o| {
                std::iter::once(o.summary.clone())
                    .chain(o.actions.iter().map(|(_, label)| label.to_string()))
            })
            .collect()
    }

    #[test]
    fn locked_note_notification_has_no_title() {
        let db = Database::open_in_memory().unwrap();
        let id = note_with_due_reminder(&db, "Bank PIN 4417");
        db.set_private(&id, true, "Money").unwrap();
        db.set_new_pin("482913").unwrap();
        db.set_privacy_locked(true, &[]);

        let out = plan(gather(&db, now(), &Paris).unwrap(), Some(STARTUP_LIMIT));
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].summary, "Private note");
        assert_eq!(out[0].summary, PRIVATE_FALLBACK_LABEL);
        for text in texts(&out) {
            assert!(!text.contains("Bank"), "{text}");
            assert!(!text.contains("Money"), "not the label either: {text}");
        }
        assert_eq!(out[0].note_id.as_deref(), Some(id.as_str()));
        assert_eq!(out[0].actions, REMINDER_ACTIONS);
    }

    #[test]
    fn private_unlocked_shows_title() {
        let db = Database::open_in_memory().unwrap();
        let id = note_with_due_reminder(&db, "Bank PIN 4417");
        db.set_private(&id, true, "Money").unwrap();
        db.set_new_pin("482913").unwrap();
        db.set_privacy_locked(false, &[]);
        let out = plan(gather(&db, now(), &Paris).unwrap(), None);
        assert_eq!(out[0].summary, "Bank PIN 4417");

        // Kept open across a lock (its window was not saved): not withheld, so shown.
        db.set_privacy_locked(true, std::slice::from_ref(&id));
        let out = plan(gather(&db, now(), &Paris).unwrap(), None);
        assert_eq!(out[0].summary, "Bank PIN 4417");
    }

    #[test]
    fn titles_and_empty_notes() {
        assert_eq!(shown_title("Dentist", false), "Dentist");
        assert_eq!(shown_title("Dentist", true), "Private note");
        assert_eq!(shown_title("", false), "Empty note");
        assert_eq!(shown_title("", true), "Private note");
        assert_eq!(masked_title("Dentist", true), "Private note");
        assert_eq!(
            masked_title("", false),
            "",
            "the manager styles empty titles itself"
        );

        let db = Database::open_in_memory().unwrap();
        note_with_due_reminder(&db, "");
        let out = plan(gather(&db, now(), &Paris).unwrap(), None);
        assert_eq!(out[0].summary, "Empty note");
    }

    #[test]
    fn notification_buttons_are_verbatim() {
        let labels: Vec<_> = REMINDER_ACTIONS.iter().map(|(_, l)| *l).collect();
        assert_eq!(labels, ["10 min", "1 h", "Tomorrow", "Dismiss", ""]);
        assert_eq!(REMINDER_ACTIONS[4].0, "default");
    }

    #[test]
    fn startup_batch_sends_at_most_the_limit() {
        let due: Vec<usize> = (0..8).collect();
        assert_eq!(startup_batch(&due, 5), (&due[..5], 3));
        assert_eq!(startup_batch(&due[..5], 5), (&due[..5], 0));
        assert_eq!(startup_batch(&due[..2], 5), (&due[..2], 0));
        let none: [usize; 0] = [];
        assert_eq!(startup_batch(&none, 5), (&none[..], 0));
    }

    #[test]
    fn startup_summary_text_has_no_titles() {
        assert_eq!(more_summary(3), "3 more reminders");
        assert_eq!(more_summary(12), "12 more reminders");
        assert_eq!(more_summary(1), "1 more reminder");

        let items: Vec<DueItem> = (0..8).map(item).collect();
        let out = plan(items.clone(), Some(5));
        assert_eq!(out.len(), 6, "five reminders and one summary");
        for (n, o) in out[..5].iter().enumerate() {
            assert_eq!(o.summary, format!("Title {n}"));
            assert_eq!(o.fires, vec![(format!("note-{n}"), n as i64)]);
            assert_eq!(o.note_id, Some(format!("note-{n}")));
        }
        let summary = &out[5];
        assert_eq!(summary.summary, "3 more reminders");
        assert_eq!(summary.note_id, None);
        assert_eq!(summary.actions, SUMMARY_ACTIONS);
        assert_eq!(
            summary.fires,
            (5..8)
                .map(|n| (format!("note-{n}"), n as i64))
                .collect::<Vec<_>>(),
            "the summed-up reminders are recorded as sent"
        );
        assert!(texts(&out[5..]).iter().all(|t| !t.contains("Title")));

        // Exactly the limit: no summary. Later passes send everything.
        assert_eq!(plan(items[..5].to_vec(), Some(5)).len(), 5);
        assert_eq!(plan(items.clone(), None).len(), 8);
        assert!(plan(Vec::new(), Some(5)).is_empty());
    }

    #[test]
    fn gather_lists_what_is_due_once() {
        let db = Database::open_in_memory().unwrap();
        let id = note_with_due_reminder(&db, "Dentist");
        let due = gather(&db, now(), &Paris).unwrap();
        assert_eq!(due.len(), 1);
        assert_eq!(due[0].note_id, id);
        assert_eq!(
            due[0].effective_due,
            utc(2026, 11, 4, 9, 30).timestamp_millis()
        );
        assert_eq!(due[0].heading.title, "Dentist");
        db.mark_fired(&id, due[0].effective_due).unwrap();
        assert!(gather(&db, now(), &Paris).unwrap().is_empty());
    }

    #[test]
    fn action_keys_map_to_core_calls() {
        assert_eq!(
            action_for_key("snooze10"),
            Some(ReminderAction::Snooze(Snooze::Minutes10))
        );
        assert_eq!(
            action_for_key("snooze60"),
            Some(ReminderAction::Snooze(Snooze::Hour1))
        );
        assert_eq!(
            action_for_key("tomorrow"),
            Some(ReminderAction::Snooze(Snooze::Tomorrow))
        );
        assert_eq!(action_for_key("dismiss"), Some(ReminderAction::Dismiss));
        assert_eq!(action_for_key("default"), Some(ReminderAction::Open));
        assert_eq!(action_for_key("Dismiss"), None);
        assert_eq!(action_for_key(""), None);
        // Every button of the notification has a meaning.
        for (key, _) in REMINDER_ACTIONS {
            assert!(action_for_key(key).is_some(), "{key}");
        }
    }

    #[test]
    fn actions_snooze_and_dismiss_through_the_core() {
        let db = Database::open_in_memory().unwrap();
        let id = note_with_due_reminder(&db, "Dentist");
        let r = |db: &Database| db.reminder(&id).unwrap();

        apply(
            &db,
            &id,
            ReminderAction::Snooze(Snooze::Minutes10),
            now(),
            &Paris,
        )
        .unwrap();
        assert_eq!(
            r(&db).unwrap().snoozed_until,
            Some(utc(2026, 11, 4, 10, 10).timestamp_millis())
        );
        apply(
            &db,
            &id,
            ReminderAction::Snooze(Snooze::Hour1),
            now(),
            &Paris,
        )
        .unwrap();
        assert_eq!(
            r(&db).unwrap().snoozed_until,
            Some(utc(2026, 11, 4, 11, 0).timestamp_millis())
        );
        apply(
            &db,
            &id,
            ReminderAction::Snooze(Snooze::Tomorrow),
            now(),
            &Paris,
        )
        .unwrap();
        assert_eq!(
            r(&db).unwrap().snoozed_until,
            Some(utc(2026, 11, 5, 9, 30).timestamp_millis()),
            "tomorrow at the reminder's own wall-clock time"
        );
        let before = r(&db);
        apply(&db, &id, ReminderAction::Open, now(), &Paris).unwrap();
        assert_eq!(r(&db), before, "opening changes nothing");
        apply(&db, &id, ReminderAction::Dismiss, now(), &Paris).unwrap();
        assert_eq!(r(&db), None, "a dismissed one-off is removed");

        let err = apply(&db, &id, ReminderAction::Dismiss, now(), &Paris).unwrap_err();
        assert_eq!(err.code(), "not_found");
    }

    #[test]
    fn sleep_is_capped_at_a_minute() {
        let t = 1_000_000;
        assert_eq!(sleep_for(t, None, None), MAX_SLEEP);
        assert_eq!(sleep_for(t, Some(t + 5_000), None), Duration::from_secs(5));
        assert_eq!(sleep_for(t, Some(t + 3_600_000), None), MAX_SLEEP);
        assert_eq!(sleep_for(t, Some(t - 10), None), Duration::ZERO);
        assert_eq!(
            sleep_for(t, Some(t + 50_000), Some(Duration::from_secs(20))),
            Duration::from_secs(20)
        );
        assert_eq!(sleep_for(t, None, Some(Duration::ZERO)), Duration::ZERO);
    }
}
