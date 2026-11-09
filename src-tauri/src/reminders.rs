//! The reminder scheduler and the notification actions (spec §3.3).
//!
//! One thread waits until the next reminder is due, or 60 s at most, so a change of
//! the clock or the time zone is noticed within a minute. It also wakes at once when a
//! reminder changes, at start and when the computer resumes from sleep. On each wake
//! it re-anchors the reminders if the local UTC offset changed (ruling R4) or a backup
//! was restored, asks the core which reminders are due, sends one notification per
//! reminder and records it as fired; a fire that could not be recorded is retried and
//! never sent twice. The core owns every time rule; this module only moves data
//! between the core and the desktop's notification service.
//!
//! Privacy: a notification shows the note's title, or "Private note" while the lock
//! withholds the note (ruling R6). Nothing here logs a title or puts one in an event.
//! When the lock engages, notifications that showed a title of a note now withheld are
//! closed (ruling R10).
//!
//! A button acts only on the occurrence its notification announced: once the reminder
//! changed (dismissed or snoozed elsewhere, set again), the old notification's buttons
//! do nothing, and a note's notifications are closed whenever its reminder changes.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use chrono::{DateTime, Local, Offset, TimeZone, Utc};
use desknotes_core::reminders::{ReminderHeading, Snooze};
use desknotes_core::{CoreResult, Database, PRIVATE_FALLBACK_LABEL};
use tauri::{AppHandle, Manager};

use crate::error::IpcResult;
use crate::platform::notify::{Notification, Notifier, Notify, Signal};
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
/// GNOME Shell 46 draws only the first three buttons, in the order sent, so "Dismiss"
/// comes before "Tomorrow" (ruling R21); desktops with room show all four.
pub const REMINDER_ACTIONS: &[(&str, &str)] = &[
    ("snooze10", "10 min"),
    ("snooze60", "1 h"),
    ("dismiss", "Dismiss"),
    ("tomorrow", "Tomorrow"),
    ("default", ""),
];
/// The summary of a start-up burst has no buttons; a click shows the manager.
pub const SUMMARY_ACTIONS: &[(&str, &str)] = &[("default", "")];

/// The title a reminder may show: "Private note" while the lock withholds the note
/// (ruling R6), else the real title (possibly empty). The manager's Reminders tab shows
/// the note's private label instead (`ReminderRow::locked_label`).
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
    /// The note and effective due time its buttons apply to; `None` for the summary.
    pub reminder: Option<(String, i64)>,
    /// The summary is the note's real title (not "Private note", "Empty note" or a count).
    pub showed_title: bool,
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
            reminder: Some((item.note_id.clone(), item.effective_due)),
            showed_title: !item.heading.locked && !item.heading.title.is_empty(),
            fires: vec![(item.note_id.clone(), item.effective_due)],
        })
        .collect();
    if more > 0 {
        out.push(Outgoing {
            summary: more_summary(more),
            actions: SUMMARY_ACTIONS,
            reminder: None,
            showed_title: false,
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

/// Apply `action` only while the note's reminder is still due at `expected_due` (the
/// occurrence its notification announced). Returns whether it was applied. Callers run
/// it inside one `with_db` call, so nothing can change the reminder in between.
pub fn apply_if_current<Tz: TimeZone>(
    db: &Database,
    note_id: &str,
    expected_due: i64,
    action: ReminderAction,
    now: DateTime<Utc>,
    tz: &Tz,
) -> CoreResult<bool> {
    match db.reminder(note_id)? {
        Some(r) if r.effective_due() == expected_due => {
            apply(db, note_id, action, now, tz)?;
            Ok(true)
        }
        _ => Ok(false),
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

/// Database access as the app has it ([`AppState::with_db`]); tests use a bare database.
pub trait DbAccess {
    fn db<T>(&self, f: impl FnOnce(&Database) -> CoreResult<T>) -> IpcResult<T>;
}

impl DbAccess for AppState {
    fn db<T>(&self, f: impl FnOnce(&Database) -> CoreResult<T>) -> IpcResult<T> {
        self.with_db(f)
    }
}

/// A notification on screen.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Shown {
    /// The note and the effective due time it announced; `None` for the summary.
    reminder: Option<(String, i64)>,
    /// It shows the note's real title (closed if the note becomes locked, R10).
    showed_title: bool,
}

impl Shown {
    fn note_id(&self) -> Option<&str> {
        self.reminder.as_ref().map(|(id, _)| id.as_str())
    }
}

/// The scheduler's shared state (Tauri-managed).
pub struct Scheduler {
    pending: Mutex<bool>,
    woken: Condvar,
    notifier: Arc<dyn Notify>,
    /// Notifications on screen, by id.
    shown: Mutex<HashMap<u32, Shown>>,
    /// Notifications to take away at the next pass (out of date).
    to_close: Mutex<Vec<u32>>,
    /// The privacy lock engaged: close notifications that show a now-withheld title.
    lock_engaged: AtomicBool,
    /// The database was replaced (a backup restored): re-anchor at the next pass, as
    /// when the UTC offset changes, since its due times may come from another zone.
    reanchor_pending: AtomicBool,
    /// The computer resumed from sleep: the next pass is a burst again, capped at
    /// [`STARTUP_LIMIT`] like the one at start (owner decision 2026-11-09).
    resumed: AtomicBool,
    /// Notes whose reminder the person changed since the last pass: a fire sent but
    /// not recorded for them is not retried, so it can never mark the new reminder fired.
    changed_notes: Mutex<HashSet<String>>,
    /// Bumped each time the database is replaced, while the database lock is held. A
    /// pass reads it inside its own database calls, so it never records or keeps a
    /// notification gathered from the other database.
    epoch: AtomicU64,
}

impl Scheduler {
    pub fn new(notifier: Arc<dyn Notify>) -> Self {
        Self {
            pending: Mutex::new(true),
            woken: Condvar::new(),
            notifier,
            shown: Mutex::new(HashMap::new()),
            to_close: Mutex::new(Vec::new()),
            lock_engaged: AtomicBool::new(false),
            reanchor_pending: AtomicBool::new(false),
            resumed: AtomicBool::new(false),
            changed_notes: Mutex::new(HashSet::new()),
            epoch: AtomicU64::new(0),
        }
    }

    /// The database was replaced: every notification on screen is about the old one, so
    /// all are closed at the next pass, and reminders are re-anchored. Call it while
    /// holding the database lock, in the same call that replaced the database.
    fn database_replaced(&self) {
        self.epoch.fetch_add(1, Ordering::AcqRel);
        let ids: Vec<u32> = lock(&self.shown).drain().map(|(id, _)| id).collect();
        lock(&self.to_close).extend(ids);
        self.request_reanchor();
    }

    /// The person changed the note's reminder (set, removed, snoozed, dismissed).
    fn reminder_changed(&self, note_id: &str) {
        self.forget_note(note_id);
        lock(&self.changed_notes).insert(note_id.to_owned());
    }

    /// Re-anchor every reminder at the next pass, and wake now.
    fn request_reanchor(&self) {
        self.reanchor_pending.store(true, Ordering::Release);
        self.wake();
    }

    fn wake(&self) {
        *lock(&self.pending) = true;
        self.woken.notify_one();
    }

    /// Sleep for `timeout` or until woken.
    fn wait(&self, timeout: Duration) {
        let guard = lock(&self.pending);
        let (mut pending, _) = self
            .woken
            .wait_timeout_while(guard, timeout, |p| !*p)
            .unwrap_or_else(|e| e.into_inner());
        *pending = false;
    }

    /// The note's reminder changed: its notifications are out of date and are closed
    /// at the next pass; their buttons no longer do anything.
    fn forget_note(&self, note_id: &str) {
        let mut shown = lock(&self.shown);
        let ids: Vec<u32> = shown
            .iter()
            .filter(|(_, s)| s.note_id() == Some(note_id))
            .map(|(id, _)| *id)
            .collect();
        for id in &ids {
            shown.remove(id);
        }
        drop(shown);
        lock(&self.to_close).extend(ids);
    }

    /// Close now the notifications queued by [`Self::forget_note`].
    fn close_stale(&self, log: &mut dyn FnMut(&str)) {
        let stale = std::mem::take(&mut *lock(&self.to_close));
        for id in stale {
            self.close(id, log);
        }
    }

    /// Take notification `id` away. A failure is logged without any text; the
    /// service may already have removed it.
    fn close(&self, id: u32, log: &mut dyn FnMut(&str)) {
        lock(&self.shown).remove(&id);
        if let Err(e) = self.notifier.close(id) {
            log(&format!("a reminder notification could not be closed: {e}"));
        }
    }

    /// The ids of notifications that showed the title of a note the lock now withholds
    /// (or of a note that no longer exists).
    fn withheld_titles<D: DbAccess>(&self, db: &D) -> IpcResult<Vec<u32>> {
        let candidates: Vec<(u32, String)> = lock(&self.shown)
            .iter()
            .filter(|(_, s)| s.showed_title)
            .filter_map(|(id, s)| Some((*id, s.note_id()?.to_owned())))
            .collect();
        if candidates.is_empty() {
            return Ok(Vec::new());
        }
        db.db(|db| {
            let mut out = Vec::new();
            for (id, note_id) in candidates {
                if db.reminder_heading(&note_id)?.is_none_or(|h| h.locked) {
                    out.push(id);
                }
            }
            Ok(out)
        })
    }
}

/// Create the scheduler and start its thread. Call once, after the state and the
/// manager exist (a click on a notification may open a note).
pub fn start(app: &AppHandle) {
    let handle = app.clone();
    let notifier = Notifier::new(move |signal| on_signal(&handle, signal));
    app.manage(Scheduler::new(Arc::new(notifier)));
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

/// A reminder changed (set, removed, snoozed, dismissed): close the note's
/// notifications, tell every window and wake the scheduler.
pub fn changed(app: &AppHandle, note_id: Option<&str>) {
    if let (Some(scheduler), Some(id)) = (app.try_state::<Scheduler>(), note_id) {
        scheduler.reminder_changed(id);
    }
    windows::emit_reminders_changed(app, note_id);
    wake(app);
}

/// The privacy lock engaged (or a note became withheld). Only flags and wakes: the
/// lock path never waits for the notification service.
pub fn on_locked(app: &AppHandle) {
    if let Some(scheduler) = app.try_state::<Scheduler>() {
        scheduler.lock_engaged.store(true, Ordering::Release);
        scheduler.wake();
    }
}

/// The database was replaced by a backup: close every notification about the old one
/// and re-anchor every reminder at the next pass. Call it inside the `with_db` call that
/// restored, so no pass can read the new database before it is known to be new.
pub fn database_replaced(app: &AppHandle) {
    if let Some(scheduler) = app.try_state::<Scheduler>() {
        scheduler.database_replaced();
    }
}

/// The computer resumed from sleep: wake now, with the start-up cap on what is sent.
pub fn resumed(app: &AppHandle) {
    if let Some(scheduler) = app.try_state::<Scheduler>() {
        scheduler.resumed.store(true, Ordering::Release);
        scheduler.wake();
    }
}

/// What the scheduler remembers between wakes.
struct Run {
    /// The start-up burst limit applies until one pass sent everything it had.
    first: bool,
    /// Reminder notifications sent during the start-up burst (across retries), so a
    /// failed send cannot raise the burst above [`STARTUP_LIMIT`].
    burst_sent: usize,
    /// The local UTC offset (seconds) at the last pass; `None` before the first.
    offset: Option<i32>,
    /// No notification is tried before this, after the service failed.
    retry_at: Option<Instant>,
    /// The last failure was logged; cleared by a success.
    failing: bool,
    /// The database could not be read at the last pass (logged once).
    unavailable: bool,
    /// Fires sent but not recorded (the database failed): retried at each pass and
    /// never sent again meanwhile.
    unrecorded: HashSet<(String, i64)>,
    /// Fires `due_reminders` produced that this pass recorded with `mark_fired`, each
    /// with the effective due time given to it, for automation rule 2. Drained after
    /// every pass; a recorded fire is never due again, so it is here only once.
    recorded: Vec<(String, i64)>,
    /// The database epoch `unrecorded` belongs to.
    epoch: u64,
}

impl Run {
    fn new() -> Self {
        Self {
            first: true,
            burst_sent: 0,
            offset: None,
            retry_at: None,
            failing: false,
            unavailable: false,
            unrecorded: HashSet::new(),
            recorded: Vec::new(),
            epoch: 0,
        }
    }
}

/// Wall-clock time that ran this much past the monotonic clock (which stops while the
/// computer sleeps) means the computer slept.
const SLEEP_GAP_MS: i64 = 30_000;

/// Whether the computer slept between two passes: `wall_ms` of wall-clock time went by
/// while the monotonic clock counted only `mono`. A clock set forward by hand also
/// counts, which only caps the next burst.
pub fn slept(mono: Duration, wall_ms: i64) -> bool {
    let mono_ms = i64::try_from(mono.as_millis()).unwrap_or(i64::MAX);
    wall_ms.saturating_sub(mono_ms) > SLEEP_GAP_MS
}

fn run(app: &AppHandle) {
    let mut run = Run::new();
    let mut log = |line: &str| eprintln!("DeskNotes: {line}");
    // The resume signal may come after the first pass that follows waking (logind is
    // busy then), and some systems have none: notice the sleep here as well.
    let mut last_pass: Option<(Instant, i64)> = None;
    loop {
        let state = app.state::<AppState>();
        let scheduler = app.state::<Scheduler>();
        let wall_now = Utc::now().timestamp_millis();
        if let Some((mono, wall)) = last_pass
            && slept(mono.elapsed(), wall_now - wall)
        {
            scheduler.resumed.store(true, Ordering::Release);
        }
        last_pass = Some((Instant::now(), wall_now));
        let offset = Local::now().offset().fix().local_minus_utc();
        let changed = pass(
            &*state,
            &scheduler,
            &mut run,
            Utc::now(),
            &Local,
            offset,
            &mut log,
        );
        // Automation rule 2, for each fire just recorded (live or in the start-up
        // summary), with the effective due time given to `mark_fired`.
        for (note_id, due) in std::mem::take(&mut run.recorded) {
            crate::automation::on_fired(app, &note_id, due);
        }
        if changed {
            windows::emit_reminders_changed(app, None);
        }
        let now = Utc::now();
        let next = state.with_db(|db| db.next_wake(now, &Local)).ok().flatten();
        let retry_in = run
            .retry_at
            .map(|at| at.saturating_duration_since(Instant::now()));
        scheduler.wait(sleep_for(now.timestamp_millis(), next, retry_in));
    }
}

/// One wake: close out-of-date and newly withheld notifications, re-anchor if the
/// zone's offset changed, send what is due and record it fired. Returns whether any
/// reminder changed. `log` lines never contain a title.
fn pass<D: DbAccess, Tz: TimeZone>(
    db: &D,
    scheduler: &Scheduler,
    run: &mut Run,
    now: DateTime<Utc>,
    tz: &Tz,
    offset: i32,
    log: &mut dyn FnMut(&str),
) -> bool {
    // After sleep, what came due meanwhile arrives as a capped burst, as at start.
    if scheduler.resumed.swap(false, Ordering::AcqRel) {
        run.first = true;
        run.burst_sent = 0;
    }
    // Out-of-date notifications (their reminder changed) go first.
    scheduler.close_stale(log);
    // R10: the lock engaged. If the check fails the flag is kept for the next pass.
    if scheduler.lock_engaged.swap(false, Ordering::AcqRel) {
        match scheduler.withheld_titles(db) {
            Ok(ids) => ids.into_iter().for_each(|id| scheduler.close(id, log)),
            Err(e) => {
                scheduler.lock_engaged.store(true, Ordering::Release);
                log(&format!(
                    "reminder notifications could not be checked: {}",
                    e.code
                ));
            }
        }
    }

    // Fires sent but not recorded: record them now. A reminder changed since makes
    // `mark_fired` a no-op, which also ends the entry. Failures were logged already.
    // Fires from a database since replaced are about notes that may not exist any more.
    let epoch = scheduler.epoch.load(Ordering::Acquire);
    if run.epoch != epoch {
        run.unrecorded.clear();
        run.epoch = epoch;
    }
    // A reminder the person changed is not marked fired by an old fire; that fire was
    // sent, so rule 2 still hears of it (it checks the reminder's due time itself).
    let changed_notes = std::mem::take(&mut *lock(&scheduler.changed_notes));
    let (dropped, kept): (Vec<_>, Vec<_>) = run
        .unrecorded
        .drain()
        .partition(|(note_id, _)| changed_notes.contains(note_id));
    run.unrecorded.extend(kept);
    run.recorded.extend(dropped);
    if !run.unrecorded.is_empty() {
        let pending: Vec<(String, i64)> = run.unrecorded.iter().cloned().collect();
        for fire in pending {
            let marked = db.db(|db| {
                if scheduler.epoch.load(Ordering::Acquire) != epoch {
                    return Ok(false);
                }
                db.mark_fired(&fire.0, fire.1).map(|()| true)
            });
            match marked {
                Ok(true) => {
                    run.unrecorded.remove(&fire);
                    run.recorded.push(fire);
                }
                // The database was replaced meanwhile: the next pass clears the rest.
                Ok(false) => break,
                Err(_) => {}
            }
        }
    }

    let mut changed = false;
    // A restored backup re-anchors as an offset change does. Kept if the read fails.
    // Read under the database lock, with the epoch: a restore sets both in its own call.
    let mut reanchor = false;
    let mut gathered_epoch = epoch;
    let gathered = db.db(|db| {
        reanchor = scheduler.reanchor_pending.swap(false, Ordering::AcqRel);
        gathered_epoch = scheduler.epoch.load(Ordering::Acquire);
        if reanchor || run.offset != Some(offset) {
            changed |= db.reanchor_reminders(now, tz)? > 0;
        }
        gather(db, now, tz)
    });
    let mut items = match gathered {
        Ok(items) => {
            run.offset = Some(offset);
            run.unavailable = false;
            items
        }
        Err(e) => {
            if reanchor {
                scheduler.reanchor_pending.store(true, Ordering::Release);
            }
            if !run.unavailable {
                log(&format!("reminders could not be read: {}", e.code));
            }
            run.unavailable = true;
            return changed;
        }
    };
    items.retain(|i| {
        !run.unrecorded
            .contains(&(i.note_id.clone(), i.effective_due))
    });
    if run.retry_at.is_some_and(|at| Instant::now() < at) {
        return changed;
    }

    let limit = run
        .first
        .then(|| STARTUP_LIMIT.saturating_sub(run.burst_sent));
    for out in plan(items, limit) {
        let sent = scheduler.notifier.send(&Notification {
            summary: &out.summary,
            actions: out.actions,
        });
        let id = match sent {
            Ok(id) => id,
            Err(e) => {
                // Not marked fired: it stays due and is tried again after the wait.
                if !run.failing {
                    log(&format!("reminder notification failed: {e}"));
                }
                run.failing = true;
                run.retry_at = Some(Instant::now() + RETRY_AFTER);
                return changed;
            }
        };
        if let Some((note_id, _)) = &out.reminder {
            if run.first {
                run.burst_sent += 1;
            }
            // A new occurrence (ruling R5): the reminder's older notifications are out
            // of date and their buttons do nothing, so take them away.
            scheduler.forget_note(note_id);
            scheduler.close_stale(log);
        } else {
            // A new summary replaces the one before, so `shown` cannot grow with
            // summaries whose NotificationClosed never came.
            let old: Vec<u32> = lock(&scheduler.shown)
                .iter()
                .filter(|(_, s)| s.reminder.is_none())
                .map(|(id, _)| *id)
                .collect();
            old.into_iter().for_each(|id| scheduler.close(id, log));
        }
        lock(&scheduler.shown).insert(
            id,
            Shown {
                reminder: out.reminder.clone(),
                showed_title: out.showed_title,
            },
        );
        let marked = db.db(|db| {
            // The database was replaced after this was gathered: it is about the old one.
            if scheduler.epoch.load(Ordering::Acquire) != gathered_epoch {
                return Ok(None);
            }
            for (note_id, due) in &out.fires {
                db.mark_fired(note_id, *due)?;
            }
            // R10: the lock may have engaged while this title was on its way.
            match (&out.reminder, out.showed_title) {
                (Some((note_id, _)), true) => {
                    Ok(Some(db.reminder_heading(note_id)?.is_none_or(|h| h.locked)))
                }
                _ => Ok(Some(false)),
            }
        });
        match marked {
            Ok(None) => {
                scheduler.close(id, log);
                return changed;
            }
            Ok(Some(closed)) => {
                run.recorded.extend(out.fires.iter().cloned());
                if closed {
                    scheduler.close(id, log);
                }
            }
            Err(e) => {
                // Sent: never sent again. Recorded at a later pass (see above).
                log(&format!(
                    "a sent reminder could not be recorded: {}",
                    e.code
                ));
                run.unrecorded.extend(out.fires.iter().cloned());
            }
        }
        changed = true;
    }
    run.first = false;
    run.failing = false;
    run.retry_at = None;
    changed
}

/// What to do after a button or the notification was clicked.
#[derive(Debug, Clone, PartialEq, Eq)]
enum ActionOutcome {
    /// Not ours, already answered, out of date or an unknown key: nothing happens.
    Ignored,
    OpenNote(String),
    ShowManager,
    /// The note's reminder was snoozed or dismissed.
    Changed(String),
    /// The core refused (error code only).
    Failed(String),
}

/// Handle a click on notification `id`. A snooze or dismiss applies only while the
/// reminder is still due at the time the notification announced.
fn handle_action<D: DbAccess, Tz: TimeZone>(
    db: &D,
    scheduler: &Scheduler,
    id: u32,
    key: &str,
    now: DateTime<Utc>,
    tz: &Tz,
) -> ActionOutcome {
    // Unknown ids belong to another app or were already answered.
    let Some(shown) = lock(&scheduler.shown).remove(&id) else {
        return ActionOutcome::Ignored;
    };
    match (shown.reminder, action_for_key(key)) {
        (None, Some(ReminderAction::Open)) => ActionOutcome::ShowManager,
        (Some((note_id, _)), Some(ReminderAction::Open)) => ActionOutcome::OpenNote(note_id),
        (Some((note_id, due)), Some(action)) => {
            match db.db(|db| apply_if_current(db, &note_id, due, action, now, tz)) {
                Ok(true) => {
                    scheduler.reminder_changed(&note_id);
                    ActionOutcome::Changed(note_id)
                }
                Ok(false) => ActionOutcome::Ignored,
                Err(e) => ActionOutcome::Failed(e.code),
            }
        }
        _ => ActionOutcome::Ignored,
    }
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
    let state = app.state::<AppState>();
    match handle_action(&*state, &scheduler, id, &key, Utc::now(), &Local) {
        ActionOutcome::Ignored => {}
        ActionOutcome::ShowManager => {
            if let Err(e) = windows::show_manager(app) {
                eprintln!("DeskNotes: could not show the manager: {e}");
            }
        }
        ActionOutcome::OpenNote(note_id) => open_note(app, &note_id),
        ActionOutcome::Changed(note_id) => {
            windows::emit_reminders_changed(app, Some(&note_id));
            scheduler.wake();
        }
        ActionOutcome::Failed(code) => eprintln!("DeskNotes: reminder action failed: {code}"),
    }
}

/// Open and focus the note, as the manager does. An archived note (or one trashed
/// since) has no window: the manager is shown instead, where it can be found (R11).
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
        assert_eq!(
            out[0].reminder.as_ref().map(|r| r.0.as_str()),
            Some(id.as_str())
        );
        assert!(!out[0].showed_title);
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
        assert_eq!(labels, ["10 min", "1 h", "Dismiss", "Tomorrow", ""]);
        assert_eq!(REMINDER_ACTIONS[4].0, "default");
    }

    #[test]
    fn dismiss_is_among_the_three_buttons_gnome_shows() {
        // GNOME Shell 46 draws the first three buttons, in the order sent (R21).
        let buttons: Vec<_> = REMINDER_ACTIONS
            .iter()
            .map(|(key, _)| *key)
            .filter(|key| *key != "default")
            .collect();
        let dismiss = buttons.iter().position(|k| *k == "dismiss").unwrap();
        assert!(dismiss < 3, "{buttons:?}");
        assert_eq!(&buttons[..2], ["snooze10", "snooze60"]);
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
            assert_eq!(o.reminder, Some((format!("note-{n}"), n as i64)));
            assert!(o.showed_title);
        }
        let summary = &out[5];
        assert_eq!(summary.summary, "3 more reminders");
        assert_eq!(summary.reminder, None);
        assert!(!summary.showed_title);
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

    // ---- pass() and buttons, against a real in-memory database and a fake service ----

    use crate::platform::notify::NotifyError;

    impl DbAccess for Database {
        fn db<T>(&self, f: impl FnOnce(&Database) -> CoreResult<T>) -> IpcResult<T> {
            Ok(f(self)?)
        }
    }

    #[derive(Default)]
    struct FakeState {
        sent: Vec<(u32, String)>,
        closed: Vec<u32>,
        /// Sends after this many attempts fail.
        fail_after: Option<usize>,
        attempts: usize,
        /// Runs during each successful send, as if something happened meanwhile.
        on_send: Option<Box<dyn Fn() + Send>>,
    }

    #[derive(Default)]
    struct Fake(Mutex<FakeState>);

    impl Fake {
        fn state(&self) -> std::sync::MutexGuard<'_, FakeState> {
            self.0.lock().unwrap()
        }
        fn summaries(&self) -> Vec<String> {
            self.state().sent.iter().map(|(_, s)| s.clone()).collect()
        }
        fn last_id(&self) -> u32 {
            self.state().sent.last().unwrap().0
        }
    }

    impl Notify for Fake {
        fn send(&self, n: &Notification<'_>) -> Result<u32, NotifyError> {
            let mut s = self.state();
            s.attempts += 1;
            if s.fail_after.is_some_and(|ok| s.attempts > ok) {
                return Err(NotifyError(
                    "org.freedesktop.DBus.Error.ServiceUnknown".into(),
                ));
            }
            let id = 100 + s.attempts as u32;
            s.sent.push((id, n.summary.to_owned()));
            if let Some(hook) = &s.on_send {
                hook();
            }
            Ok(id)
        }
        fn close(&self, id: u32) -> Result<(), NotifyError> {
            self.state().closed.push(id);
            Ok(())
        }
    }

    fn scheduler() -> (Arc<Fake>, Scheduler) {
        let fake = Arc::new(Fake::default());
        let s = Scheduler::new(fake.clone());
        (fake, s)
    }

    const PARIS_OFFSET: i32 = 3600;

    fn tick<D: DbAccess>(db: &D, s: &Scheduler, run: &mut Run, log: &mut Vec<String>) -> bool {
        pass(db, s, run, now(), &Paris, PARIS_OFFSET, &mut |l| {
            log.push(l.to_owned())
        })
    }

    fn fired(db: &Database, id: &str) -> bool {
        let r = db.reminder(id).unwrap().unwrap();
        r.fired_at == Some(r.effective_due())
    }

    #[test]
    fn a_failed_send_is_not_marked_fired_and_is_logged_once_without_the_title() {
        let db = Database::open_in_memory().unwrap();
        let id = note_with_due_reminder(&db, "Dentist");
        let (fake, s) = scheduler();
        fake.state().fail_after = Some(0);
        let (mut run, mut log) = (Run::new(), Vec::new());

        assert!(!tick(&db, &s, &mut run, &mut log));
        assert!(!fired(&db, &id), "stays due for the retry");
        assert!(run.retry_at.is_some() && run.failing);
        assert_eq!(log.len(), 1);
        assert!(
            log[0].contains("reminder notification failed"),
            "{}",
            log[0]
        );
        assert!(log[0].contains("ServiceUnknown"));
        assert!(!log[0].contains("Dentist"));

        // Woken again within the minute: nothing is tried.
        tick(&db, &s, &mut run, &mut log);
        assert_eq!(fake.state().attempts, 1);
        // After the wait it tries again; a second failure is not logged again.
        run.retry_at = Some(Instant::now() - Duration::from_secs(1));
        tick(&db, &s, &mut run, &mut log);
        assert_eq!(fake.state().attempts, 2);
        assert_eq!(log.len(), 1);
        // The service is back: sent, recorded, the failure is over.
        fake.state().fail_after = None;
        run.retry_at = Some(Instant::now() - Duration::from_secs(1));
        assert!(tick(&db, &s, &mut run, &mut log));
        assert!(fired(&db, &id));
        assert!(!run.failing && run.retry_at.is_none());
        assert_eq!(fake.summaries(), ["Dentist"]);
    }

    #[test]
    fn the_start_up_summary_marks_the_rest_fired() {
        let db = Database::open_in_memory().unwrap();
        let ids: Vec<String> = (0..7)
            .map(|n| note_with_due_reminder(&db, &format!("Note {n}")))
            .collect();
        let (fake, s) = scheduler();
        let (mut run, mut log) = (Run::new(), Vec::new());
        assert!(tick(&db, &s, &mut run, &mut log));
        let summaries = fake.summaries();
        assert_eq!(summaries.len(), 6);
        assert_eq!(summaries[5], "2 more reminders");
        assert!(ids.iter().all(|id| fired(&db, id)), "all seven recorded");
        assert!(!run.first);
        // Nothing is sent again.
        tick(&db, &s, &mut run, &mut log);
        assert_eq!(fake.summaries().len(), 6);
        assert!(log.is_empty());
    }

    #[test]
    fn after_sleep_what_came_due_is_capped_like_at_start() {
        let db = Database::open_in_memory().unwrap();
        let (fake, s) = scheduler();
        let (mut run, mut log) = (Run::new(), Vec::new());
        tick(&db, &s, &mut run, &mut log); // start: nothing due
        assert!(!run.first);
        let ids: Vec<String> = (0..7)
            .map(|n| note_with_due_reminder(&db, &format!("Note {n}")))
            .collect();
        s.resumed.store(true, Ordering::Release);
        assert!(tick(&db, &s, &mut run, &mut log));
        let summaries = fake.summaries();
        assert_eq!(summaries.len(), 6, "{summaries:?}");
        assert_eq!(summaries[5], "2 more reminders");
        assert!(ids.iter().all(|id| fired(&db, id)));
        assert!(!run.first, "only the pass after waking is capped");
    }

    #[test]
    fn without_a_resume_every_due_reminder_is_sent() {
        let db = Database::open_in_memory().unwrap();
        let (fake, s) = scheduler();
        let (mut run, mut log) = (Run::new(), Vec::new());
        tick(&db, &s, &mut run, &mut log);
        for n in 0..7 {
            note_with_due_reminder(&db, &format!("Note {n}"));
        }
        tick(&db, &s, &mut run, &mut log);
        assert_eq!(fake.summaries().len(), 7);
    }

    #[test]
    fn a_new_summary_closes_the_one_before() {
        let db = Database::open_in_memory().unwrap();
        for n in 0..7 {
            note_with_due_reminder(&db, &format!("Note {n}"));
        }
        let (fake, s) = scheduler();
        let (mut run, mut log) = (Run::new(), Vec::new());
        tick(&db, &s, &mut run, &mut log);
        let first_summary = fake.last_id();
        for n in 0..7 {
            note_with_due_reminder(&db, &format!("Later {n}"));
        }
        s.resumed.store(true, Ordering::Release);
        tick(&db, &s, &mut run, &mut log);
        assert!(fake.state().closed.contains(&first_summary));
        let summaries = lock(&s.shown)
            .values()
            .filter(|shown| shown.reminder.is_none())
            .count();
        assert_eq!(summaries, 1);
    }

    #[test]
    fn a_restore_closes_every_notification_at_the_next_pass() {
        let db = Database::open_in_memory().unwrap();
        note_with_due_reminder(&db, "Dentist");
        let (fake, s) = scheduler();
        let (mut run, mut log) = (Run::new(), Vec::new());
        tick(&db, &s, &mut run, &mut log);
        let id = fake.last_id();
        s.database_replaced();
        assert!(lock(&s.shown).is_empty(), "its buttons do nothing from now");
        tick(&db, &s, &mut run, &mut log);
        assert_eq!(fake.state().closed, [id]);
    }

    #[test]
    fn a_restore_during_a_send_closes_it_and_records_nothing() {
        let db = Database::open_in_memory().unwrap();
        let id = note_with_due_reminder(&db, "Dentist");
        let fake = Arc::new(Fake::default());
        let s = Arc::new(Scheduler::new(fake.clone()));
        let weak = Arc::downgrade(&s);
        fake.state().on_send = Some(Box::new(move || {
            weak.upgrade().unwrap().database_replaced();
        }));
        let (mut run, mut log) = (Run::new(), Vec::new());
        tick(&db, &s, &mut run, &mut log);
        let sent = fake.last_id();
        assert!(
            fake.state().closed.contains(&sent),
            "about the old database"
        );
        assert!(lock(&s.shown).is_empty());
        assert!(!fired(&db, &id), "never recorded in the new database");
        assert!(run.recorded.is_empty());
    }

    #[test]
    fn what_is_due_in_a_restored_database_is_sent_and_kept() {
        let db = Database::open_in_memory().unwrap();
        let (fake, s) = scheduler();
        let (mut run, mut log) = (Run::new(), Vec::new());
        tick(&db, &s, &mut run, &mut log);
        // The restore replaced the database (here: added a due reminder) before this pass.
        let id = note_with_due_reminder(&db, "Dentist");
        s.database_replaced();
        tick(&db, &s, &mut run, &mut log);
        assert_eq!(fake.summaries(), ["Dentist"]);
        assert!(lock(&s.shown).contains_key(&fake.last_id()));
        assert!(fake.state().closed.is_empty());
        assert!(fired(&db, &id));
    }

    /// A database whose first use waits behind a restore: the restore replaces it, and
    /// tells the scheduler, before the caller's own call runs.
    struct RestoredFirst<'a> {
        db: &'a Database,
        scheduler: &'a Scheduler,
        done: AtomicBool,
    }

    impl DbAccess for RestoredFirst<'_> {
        fn db<T>(&self, f: impl FnOnce(&Database) -> CoreResult<T>) -> IpcResult<T> {
            if !self.done.swap(true, Ordering::AcqRel) {
                self.scheduler.database_replaced();
            }
            Ok(f(self.db)?)
        }
    }

    #[test]
    fn a_pass_waiting_behind_a_restore_sends_from_the_new_database_and_keeps_it() {
        let db = Database::open_in_memory().unwrap();
        let id = note_with_due_reminder(&db, "Dentist");
        let (fake, s) = scheduler();
        let (mut run, mut log) = (Run::new(), Vec::new());
        run.first = false;
        let restored = RestoredFirst {
            db: &db,
            scheduler: &s,
            done: AtomicBool::new(false),
        };
        tick(&restored, &s, &mut run, &mut log);
        assert_eq!(fake.summaries(), ["Dentist"]);
        assert!(fake.state().closed.is_empty());
        assert!(lock(&s.shown).contains_key(&fake.last_id()));
        assert!(fired(&db, &id));
    }

    #[test]
    fn a_restore_drops_fires_left_unrecorded_from_the_old_database() {
        let db = Database::open_in_memory().unwrap();
        let id = note_with_due_reminder(&db, "Dentist");
        let due = db.reminder(&id).unwrap().unwrap().effective_due();
        let (fake, s) = scheduler();
        let (mut run, mut log) = (Run::new(), Vec::new());
        run.first = false;
        run.unrecorded.insert((id.clone(), due));
        s.database_replaced();
        tick(&db, &s, &mut run, &mut log);
        assert!(run.unrecorded.is_empty());
        assert_eq!(
            fake.summaries(),
            ["Dentist"],
            "the restored reminder is its own"
        );
    }

    #[test]
    fn sleep_shows_as_wall_time_running_past_the_monotonic_clock() {
        let minute = Duration::from_secs(60);
        assert!(!slept(minute, 60_000));
        assert!(!slept(minute, 90_000), "30 s of drift is not sleep");
        assert!(slept(minute, 90_001));
        assert!(slept(Duration::from_millis(300), 8 * 3_600_000));
        assert!(!slept(minute, -3_600_000), "a clock set back is not sleep");
    }

    #[test]
    fn a_reminder_changed_by_the_person_drops_its_unrecorded_fire() {
        let db = Database::open_in_memory().unwrap();
        let id = note_with_due_reminder(&db, "Dentist");
        let due = db.reminder(&id).unwrap().unwrap().effective_due();
        let (fake, s) = scheduler();
        let (mut run, mut log) = (Run::new(), Vec::new());
        run.first = false;
        // An earlier fire at the same due time was sent but could not be recorded.
        run.unrecorded.insert((id.clone(), due));
        s.reminder_changed(&id);
        tick(&db, &s, &mut run, &mut log);
        assert!(run.unrecorded.is_empty());
        // It was sent: rule 2 still hears of it (then of the new fire).
        assert_eq!(run.recorded, [(id.clone(), due), (id.clone(), due)]);
        assert_eq!(
            fake.summaries(),
            ["Dentist"],
            "the changed reminder is announced"
        );
        assert!(fired(&db, &id));
    }

    /// A note titled "Routine" with one ticked checklist item and a daily reminder at
    /// 10:45 Paris (now due), with automation rule 2 on.
    fn routine_with_due_reminder(db: &Database) -> String {
        db.set_automations(&desknotes_core::db::Automations {
            reset_checklists_on_repeat: true,
            ..db.automations().unwrap()
        })
        .unwrap();
        let id = db.create_note(None).unwrap().id;
        db.save_content(&id, &routine_doc(true)).unwrap();
        let rule = validate_rule("2026-11-04", "10:45", "daily").unwrap();
        db.set_reminder(&id, rule, utc(2026, 11, 4, 9, 0), &Paris)
            .unwrap();
        id
    }

    fn routine_doc(checked: bool) -> String {
        serde_json::json!({"type":"doc","content":[
            {"type":"paragraph","content":[{"type":"text","text":"Routine"}]},
            {"type":"taskList","content":[{"type":"taskItem","attrs":{"checked":checked},
                "content":[{"type":"paragraph","content":[{"type":"text","text":"Stretch"}]}]}]}]})
        .to_string()
    }

    fn ticked(db: &Database, id: &str) -> bool {
        db.get_note(id)
            .unwrap()
            .content
            .to_string()
            .contains("\"checked\":true")
    }

    /// What `run` does after a pass: rule 2 for every recorded fire (window closed).
    fn after_pass(db: &Database, run: &mut Run) -> Vec<crate::automation::ResetAction> {
        let pending = crate::automation::PendingResets::default();
        run.recorded
            .drain(..)
            .map(|(id, due)| {
                crate::automation::react_to_fire(db, &pending, &id, due, false).unwrap()
            })
            .collect()
    }

    #[test]
    fn a_fire_resets_its_checklist_once_even_across_a_restart() {
        use crate::automation::ResetAction;
        let db = Database::open_in_memory().unwrap();
        let id = routine_with_due_reminder(&db);
        let due = db.reminder(&id).unwrap().unwrap().due_at;
        let (_fake, s) = scheduler();
        let (mut run, mut log) = (Run::new(), Vec::new());

        assert!(tick(&db, &s, &mut run, &mut log));
        assert_eq!(run.recorded, [(id.clone(), due)], "the occurrence's due_at");
        assert_eq!(after_pass(&db, &mut run), [ResetAction::WriteDb]);
        assert!(!ticked(&db, &id));

        // The person ticks again; the next pass and a restart do not untick twice.
        db.save_content(&id, &routine_doc(true)).unwrap();
        tick(&db, &s, &mut run, &mut log);
        assert!(run.recorded.is_empty());
        let mut restarted = Run::new();
        tick(&db, &s, &mut restarted, &mut log);
        assert!(restarted.recorded.is_empty(), "recorded: never due again");
        assert!(ticked(&db, &id));
        assert!(log.is_empty(), "{log:?}");
    }

    #[test]
    fn a_fire_in_the_start_up_summary_resets_its_checklist_once() {
        use crate::automation::ResetAction;
        let db = Database::open_in_memory().unwrap();
        for n in 0..STARTUP_LIMIT {
            note_with_due_reminder(&db, &format!("Note {n}"));
        }
        // Created last, so it is beyond the burst and fired by the summary.
        let id = routine_with_due_reminder(&db);
        let due = db.reminder(&id).unwrap().unwrap().due_at;
        let (fake, s) = scheduler();
        let (mut run, mut log) = (Run::new(), Vec::new());

        assert!(tick(&db, &s, &mut run, &mut log));
        let summaries = fake.summaries();
        assert_eq!(summaries.len(), STARTUP_LIMIT + 1);
        assert_eq!(summaries[STARTUP_LIMIT], "1 more reminder");
        assert!(!summaries.contains(&"Routine".to_owned()));
        assert_eq!(run.recorded.len(), STARTUP_LIMIT + 1);
        assert!(run.recorded.contains(&(id.clone(), due)));
        let actions = after_pass(&db, &mut run);
        assert_eq!(
            actions
                .iter()
                .filter(|a| **a == ResetAction::WriteDb)
                .count(),
            1,
            "only the routine is reset: {actions:?}"
        );
        assert!(!ticked(&db, &id));

        // Restarted after the person ticked again: the summary does not count it twice.
        db.save_content(&id, &routine_doc(true)).unwrap();
        let mut restarted = Run::new();
        tick(&db, &s, &mut restarted, &mut log);
        assert!(restarted.recorded.is_empty());
        assert!(ticked(&db, &id));
    }

    #[test]
    fn a_fire_recorded_at_a_later_pass_resets_its_checklist_once() {
        let db = Database::open_in_memory().unwrap();
        let id = routine_with_due_reminder(&db);
        let due = db.reminder(&id).unwrap().unwrap().due_at;
        let (_fake, s) = scheduler();
        let mut run = Run::new();
        // Sent at an earlier pass, but the database failed to record it.
        run.first = false;
        run.unrecorded.insert((id.clone(), due));

        tick(&db, &s, &mut run, &mut Vec::new());
        assert!(fired(&db, &id));
        assert_eq!(run.recorded, [(id.clone(), due)], "recorded now, once");
        assert_eq!(
            after_pass(&db, &mut run),
            [crate::automation::ResetAction::WriteDb]
        );
        tick(&db, &s, &mut run, &mut Vec::new());
        assert!(run.recorded.is_empty());
    }

    #[test]
    fn a_burst_interrupted_by_a_failed_send_still_sends_at_most_the_limit() {
        let db = Database::open_in_memory().unwrap();
        let ids: Vec<String> = (0..7)
            .map(|n| note_with_due_reminder(&db, &format!("Note {n}")))
            .collect();
        let (fake, s) = scheduler();
        fake.state().fail_after = Some(2);
        let (mut run, mut log) = (Run::new(), Vec::new());
        tick(&db, &s, &mut run, &mut log);
        assert_eq!(fake.summaries().len(), 2);
        assert_eq!(ids.iter().filter(|id| fired(&db, id)).count(), 2);
        assert!(run.first, "the burst limit still applies to the retry");

        fake.state().fail_after = None;
        run.retry_at = Some(Instant::now() - Duration::from_secs(1));
        tick(&db, &s, &mut run, &mut log);
        // Two were sent before the failure: three more, then a summary of the other two.
        let summaries = fake.summaries();
        let reminders = summaries.iter().filter(|t| t.starts_with("Note ")).count();
        assert_eq!(reminders, STARTUP_LIMIT, "{summaries:?}");
        assert_eq!(summaries.len(), STARTUP_LIMIT + 1);
        assert_eq!(summaries.last().unwrap(), "2 more reminders");
        assert!(ids.iter().all(|id| fired(&db, id)));
        assert!(!run.first);
    }

    /// Fails `failures` database calls made after the first notification was sent, as
    /// if the disk filled up just after a reminder went out.
    struct FailAfterSend<'a> {
        db: &'a Database,
        fake: &'a Fake,
        failures: std::cell::Cell<usize>,
    }

    impl DbAccess for FailAfterSend<'_> {
        fn db<T>(&self, f: impl FnOnce(&Database) -> CoreResult<T>) -> IpcResult<T> {
            if !self.fake.state().sent.is_empty() && self.failures.get() > 0 {
                self.failures.set(self.failures.get() - 1);
                return Err(crate::error::IpcError::new("io", "disk full"));
            }
            Ok(f(self.db)?)
        }
    }

    #[test]
    fn a_sent_reminder_that_could_not_be_recorded_is_not_sent_again() {
        let db = Database::open_in_memory().unwrap();
        let id = note_with_due_reminder(&db, "Dentist");
        let (fake, s) = scheduler();
        let (mut run, mut log) = (Run::new(), Vec::new());
        let failing = FailAfterSend {
            db: &db,
            fake: &fake,
            failures: std::cell::Cell::new(2),
        };
        // The record fails, then the first retry fails too.
        tick(&failing, &s, &mut run, &mut log);
        assert!(!fired(&db, &id));
        tick(&failing, &s, &mut run, &mut log);
        assert!(!fired(&db, &id));
        assert_eq!(fake.summaries(), ["Dentist"], "not sent again meanwhile");
        // The database is back: recorded, still sent once.
        tick(&failing, &s, &mut run, &mut log);
        assert!(fired(&db, &id));
        assert!(run.unrecorded.is_empty());
        tick(&failing, &s, &mut run, &mut log);
        assert_eq!(fake.summaries(), ["Dentist"]);
        assert_eq!(log.len(), 1, "logged once: {log:?}");
        assert!(log[0].contains("could not be recorded") && !log[0].contains("Dentist"));
    }

    #[test]
    fn an_unrecorded_fire_of_a_changed_reminder_is_dropped() {
        let db = Database::open_in_memory().unwrap();
        let id = note_with_due_reminder(&db, "Dentist");
        let (fake, s) = scheduler();
        let (mut run, mut log) = (Run::new(), Vec::new());
        let failing = FailAfterSend {
            db: &db,
            fake: &fake,
            failures: std::cell::Cell::new(1),
        };
        tick(&failing, &s, &mut run, &mut log);
        assert_eq!(run.unrecorded.len(), 1);
        // Set again for later: the old occurrence no longer matches, mark_fired is a no-op.
        let rule = validate_rule("2026-11-04", "15:00", "none").unwrap();
        db.set_reminder(&id, rule, now(), &Paris).unwrap();
        tick(&failing, &s, &mut run, &mut log);
        assert!(run.unrecorded.is_empty());
        assert_eq!(db.reminder(&id).unwrap().unwrap().fired_at, None);
    }

    #[test]
    fn a_new_occurrence_closes_the_reminders_older_notifications() {
        let db = Database::open_in_memory().unwrap();
        let id = db.create_note(None).unwrap().id;
        let rule = validate_rule("2026-11-04", "10:30", "daily").unwrap();
        db.set_reminder(&id, rule, utc(2026, 11, 4, 9, 0), &Paris)
            .unwrap();
        let other = note_with_due_reminder(&db, "Bakery");
        let (fake, s) = scheduler();
        let (mut run, mut log) = (Run::new(), Vec::new());
        tick(&db, &s, &mut run, &mut log);
        let first: Vec<(u32, String)> = fake.state().sent.clone();
        let daily = first.iter().find(|(_, t)| t == "Empty note").unwrap().0;
        let bakery = first.iter().find(|(_, t)| t == "Bakery").unwrap().0;

        // Not answered; the next day's occurrence is sent (ruling R5).
        let tomorrow = utc(2026, 11, 5, 10, 0);
        pass(
            &db,
            &s,
            &mut run,
            tomorrow,
            &Paris,
            PARIS_OFFSET,
            &mut |l| log.push(l.to_owned()),
        );
        let latest = fake.last_id();
        assert_ne!(latest, daily);
        assert_eq!(fake.state().closed, [daily], "the old one is taken away");
        let shown = lock(&s.shown);
        assert!(shown.contains_key(&latest) && shown.contains_key(&bakery));
        assert!(!shown.contains_key(&daily));
        drop(shown);
        assert!(db.reminder(&other).unwrap().is_some());
    }

    #[test]
    fn a_restore_reanchors_at_the_next_pass() {
        use chrono_tz::America::New_York;
        let db = Database::open_in_memory().unwrap();
        let id = db.create_note(None).unwrap().id;
        // 15:00 picked in Paris; the restored database is now read in New York.
        let rule = validate_rule("2026-11-04", "15:00", "none").unwrap();
        db.set_reminder(&id, rule, now(), &Paris).unwrap();
        let paris_due = utc(2026, 11, 4, 14, 0).timestamp_millis();
        let new_york_due = utc(2026, 11, 4, 20, 0).timestamp_millis();
        let (_fake, s) = scheduler();
        let (mut run, mut log) = (Run::new(), Vec::new());
        let ny_offset = -5 * 3600;
        let mut tick_ny = |s: &Scheduler, run: &mut Run| {
            pass(&db, s, run, now(), &New_York, ny_offset, &mut |l| {
                log.push(l.to_owned())
            })
        };
        run.offset = Some(ny_offset);
        tick_ny(&s, &mut run);
        assert_eq!(
            db.reminder(&id).unwrap().unwrap().due_at,
            paris_due,
            "same offset, no restore: nothing re-anchored"
        );

        s.request_reanchor();
        assert!(tick_ny(&s, &mut run), "a reminder changed");
        assert_eq!(db.reminder(&id).unwrap().unwrap().due_at, new_york_due);
        assert!(!s.reanchor_pending.load(Ordering::Acquire));
    }

    #[test]
    fn a_stale_dismiss_after_dismissing_elsewhere_changes_nothing() {
        let db = Database::open_in_memory().unwrap();
        let id = db.create_note(None).unwrap().id;
        let rule = validate_rule("2026-11-04", "10:30", "daily").unwrap();
        db.set_reminder(&id, rule, utc(2026, 11, 4, 9, 0), &Paris)
            .unwrap();
        let (fake, s) = scheduler();
        let (mut run, mut log) = (Run::new(), Vec::new());
        tick(&db, &s, &mut run, &mut log);
        let shown = fake.last_id();

        // Dismissed in the manager: the daily repeat moves to tomorrow 10:30.
        db.dismiss_reminder(&id, now(), &Paris).unwrap();
        let tomorrow = db.reminder(&id).unwrap().unwrap();
        assert_eq!(tomorrow.due_at, utc(2026, 11, 5, 9, 30).timestamp_millis());

        // The old notification's "Dismiss" must not skip tomorrow.
        let out = handle_action(&db, &s, shown, "dismiss", now(), &Paris);
        assert_eq!(out, ActionOutcome::Ignored);
        assert_eq!(db.reminder(&id).unwrap(), Some(tomorrow));
        assert!(!lock(&s.shown).contains_key(&shown), "forgotten");
    }

    #[test]
    fn a_stale_button_after_setting_a_new_time_keeps_the_new_reminder() {
        let db = Database::open_in_memory().unwrap();
        let id = note_with_due_reminder(&db, "Dentist");
        let (fake, s) = scheduler();
        let (mut run, mut log) = (Run::new(), Vec::new());
        tick(&db, &s, &mut run, &mut log);
        let shown = fake.last_id();
        let old_due = utc(2026, 11, 4, 9, 30).timestamp_millis();
        lock(&s.shown).insert(
            7,
            Shown {
                reminder: Some((id.clone(), old_due)),
                showed_title: true,
            },
        );

        let rule = validate_rule("2026-11-04", "15:00", "none").unwrap();
        let new = db.set_reminder(&id, rule, now(), &Paris).unwrap();
        assert_eq!(
            handle_action(&db, &s, shown, "dismiss", now(), &Paris),
            ActionOutcome::Ignored
        );
        assert_eq!(
            handle_action(&db, &s, 7, "snooze10", now(), &Paris),
            ActionOutcome::Ignored
        );
        assert_eq!(
            db.reminder(&id).unwrap(),
            Some(new),
            "the new reminder is kept"
        );
    }

    #[test]
    fn a_current_button_applies_and_closes_the_notes_other_notifications() {
        let db = Database::open_in_memory().unwrap();
        let id = note_with_due_reminder(&db, "Dentist");
        let other = note_with_due_reminder(&db, "Bakery");
        let (fake, s) = scheduler();
        let (mut run, mut log) = (Run::new(), Vec::new());
        tick(&db, &s, &mut run, &mut log);
        let ids: Vec<u32> = fake.state().sent.iter().map(|(n, _)| *n).collect();
        let due = utc(2026, 11, 4, 9, 30).timestamp_millis();
        lock(&s.shown).insert(
            7,
            Shown {
                reminder: Some((id.clone(), due)),
                showed_title: true,
            },
        );
        let dentist = if fake.summaries()[0] == "Dentist" {
            ids[0]
        } else {
            ids[1]
        };
        let bakery = if dentist == ids[0] { ids[1] } else { ids[0] };

        assert_eq!(
            handle_action(&db, &s, dentist, "snooze60", now(), &Paris),
            ActionOutcome::Changed(id.clone())
        );
        assert_eq!(
            db.reminder(&id).unwrap().unwrap().snoozed_until,
            Some(utc(2026, 11, 4, 11, 0).timestamp_millis())
        );
        // The note's other notification is closed at the next pass; the other note's stays.
        tick(&db, &s, &mut run, &mut log);
        assert_eq!(fake.state().closed, [7]);
        assert!(lock(&s.shown).contains_key(&bakery));
        assert!(db.reminder(&other).unwrap().is_some());

        // Dismiss on the current notification of a one-off removes it.
        assert_eq!(
            handle_action(&db, &s, bakery, "dismiss", now(), &Paris),
            ActionOutcome::Changed(other.clone())
        );
        assert_eq!(db.reminder(&other).unwrap(), None);
        // Answered once: a second click is ignored.
        assert_eq!(
            handle_action(&db, &s, bakery, "dismiss", now(), &Paris),
            ActionOutcome::Ignored
        );
    }

    #[test]
    fn clicks_open_the_note_or_the_manager() {
        let db = Database::open_in_memory().unwrap();
        for n in 0..6 {
            note_with_due_reminder(&db, &format!("Note {n}"));
        }
        let (fake, s) = scheduler();
        let (mut run, mut log) = (Run::new(), Vec::new());
        tick(&db, &s, &mut run, &mut log);
        let sent = fake.state().sent.clone();
        let (summary_id, _) = sent.last().unwrap().clone();
        assert_eq!(
            handle_action(&db, &s, summary_id, "default", now(), &Paris),
            ActionOutcome::ShowManager
        );
        let (first_id, _) = sent[0].clone();
        assert!(matches!(
            handle_action(&db, &s, first_id, "default", now(), &Paris),
            ActionOutcome::OpenNote(_)
        ));
        assert_eq!(
            handle_action(&db, &s, 9999, "dismiss", now(), &Paris),
            ActionOutcome::Ignored,
            "another app's notification"
        );
        let (second_id, _) = sent[1].clone();
        assert_eq!(
            handle_action(&db, &s, second_id, "unknown", now(), &Paris),
            ActionOutcome::Ignored
        );
    }

    #[test]
    fn changing_a_reminder_closes_its_notifications() {
        let (fake, s) = scheduler();
        let entry = |note: &str| Shown {
            reminder: Some((note.to_owned(), 1)),
            showed_title: true,
        };
        lock(&s.shown).extend([(1, entry("a")), (2, entry("a")), (3, entry("b"))]);
        s.forget_note("a");
        let db = Database::open_in_memory().unwrap();
        let (mut run, mut log) = (Run::new(), Vec::new());
        tick(&db, &s, &mut run, &mut log);
        let mut closed = fake.state().closed.clone();
        closed.sort();
        assert_eq!(closed, [1, 2]);
        assert_eq!(lock(&s.shown).keys().copied().collect::<Vec<_>>(), [3]);
        // Closed once only.
        tick(&db, &s, &mut run, &mut log);
        assert_eq!(fake.state().closed.len(), 2);
    }

    /// A private note titled `title`, labelled "Money", with a due reminder.
    fn private_note_with_due_reminder(db: &Database, title: &str) -> String {
        let id = note_with_due_reminder(db, title);
        db.set_private(&id, true, "Money").unwrap();
        id
    }

    #[test]
    fn locking_closes_notifications_that_showed_a_withheld_title() {
        let db = Database::open_in_memory().unwrap();
        db.set_new_pin("482913").unwrap();
        db.set_privacy_locked(false, &[]);
        let bank = private_note_with_due_reminder(&db, "Bank");
        let diary = private_note_with_due_reminder(&db, "Diary");
        note_with_due_reminder(&db, "Dentist");
        let (fake, s) = scheduler();
        let (mut run, mut log) = (Run::new(), Vec::new());
        tick(&db, &s, &mut run, &mut log);
        let id_of = |title: &str| {
            fake.state()
                .sent
                .iter()
                .find(|(_, t)| t == title)
                .map(|(id, _)| *id)
                .unwrap()
        };
        let (bank_id, diary_id, dentist_id) = (id_of("Bank"), id_of("Diary"), id_of("Dentist"));

        // The lock engages; the diary could not save and stays open (not withheld).
        db.set_privacy_locked(true, std::slice::from_ref(&diary));
        tick(&db, &s, &mut run, &mut log);
        assert!(
            fake.state().closed.is_empty(),
            "nothing without the lock signal"
        );
        s.lock_engaged.store(true, Ordering::Release);
        tick(&db, &s, &mut run, &mut log);
        assert_eq!(fake.state().closed, [bank_id]);
        let shown = lock(&s.shown);
        assert!(!shown.contains_key(&bank_id));
        assert!(shown.contains_key(&diary_id) && shown.contains_key(&dentist_id));
        drop(shown);
        assert!(!s.lock_engaged.load(Ordering::Acquire));
        let _ = bank;
    }

    #[test]
    fn a_locked_notes_notification_is_not_closed_on_lock() {
        let db = Database::open_in_memory().unwrap();
        db.set_new_pin("482913").unwrap();
        private_note_with_due_reminder(&db, "Bank");
        db.set_privacy_locked(true, &[]);
        let (fake, s) = scheduler();
        let (mut run, mut log) = (Run::new(), Vec::new());
        tick(&db, &s, &mut run, &mut log);
        assert_eq!(fake.summaries(), ["Private note"]);
        s.lock_engaged.store(true, Ordering::Release);
        tick(&db, &s, &mut run, &mut log);
        assert!(fake.state().closed.is_empty(), "it never showed the title");
    }

    /// Engages the lock at the first database access after a notification was sent,
    /// as if the person locked DeskNotes while the notification was on its way.
    struct LockAfterSend<'a> {
        db: &'a Database,
        fake: &'a Fake,
    }

    impl DbAccess for LockAfterSend<'_> {
        fn db<T>(&self, f: impl FnOnce(&Database) -> CoreResult<T>) -> IpcResult<T> {
            if !self.fake.state().sent.is_empty() && !self.db.privacy_locked() {
                self.db.set_privacy_locked(true, &[]);
            }
            Ok(f(self.db)?)
        }
    }

    #[test]
    fn a_title_sent_as_the_lock_engages_is_closed_at_once() {
        let db = Database::open_in_memory().unwrap();
        db.set_new_pin("482913").unwrap();
        db.set_privacy_locked(false, &[]);
        let bank = private_note_with_due_reminder(&db, "Bank");
        let (fake, s) = scheduler();
        let (mut run, mut log) = (Run::new(), Vec::new());
        let racing = LockAfterSend {
            db: &db,
            fake: &fake,
        };
        tick(&racing, &s, &mut run, &mut log);
        assert_eq!(fake.summaries(), ["Bank"]);
        let sent = fake.last_id();
        assert_eq!(fake.state().closed, [sent], "closed right after sending");
        assert!(lock(&s.shown).is_empty());
        assert!(fired(&db, &bank), "still recorded as sent");
    }
}
