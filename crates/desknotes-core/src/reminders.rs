//! Reminder time rules (spec §3.3–3.4, §4): pure functions, no clock, no database.
//!
//! A reminder keeps the local wall-clock date and time the user picked plus a repeat
//! rule. Callers pass the current instant and the time zone (`chrono::Local` in the
//! app, fixed IANA zones in tests); results are UTC instants. Changing the time zone
//! therefore keeps the wall-clock time.
//!
//! Wall-clock times that do not exist (a DST gap) resolve to the first valid minute
//! after the gap; times that exist twice (a DST overlap) resolve to the first instance
//! only, so a reminder never fires twice for one occurrence.

use std::fmt;
use std::str::FromStr;

use chrono::{
    DateTime, Datelike, NaiveDate, NaiveDateTime, NaiveTime, Offset, TimeDelta, TimeZone, Utc,
    Weekday,
};
use serde::{Deserialize, Serialize};

use crate::error::{CoreError, CoreResult};

/// Occurrences are searched up to the end of this year; later instants have none.
const LAST_YEAR: i32 = 9999;
/// Days scanned for the next matching date. A monthly rule needs at most ~32.
const SEARCH_DAYS: u32 = 400;
/// Hours scanned forward out of a DST gap (real gaps are an hour, a day at most).
const GAP_SEARCH_HOURS: u32 = 48;

/// How a reminder repeats. Stored and sent over IPC as the lowercase name.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Repeat {
    None,
    Daily,
    Weekdays,
    Weekly,
    Monthly,
}

impl Repeat {
    pub fn as_str(self) -> &'static str {
        match self {
            Repeat::None => "none",
            Repeat::Daily => "daily",
            Repeat::Weekdays => "weekdays",
            Repeat::Weekly => "weekly",
            Repeat::Monthly => "monthly",
        }
    }
}

impl fmt::Display for Repeat {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

impl FromStr for Repeat {
    type Err = CoreError;

    fn from_str(s: &str) -> CoreResult<Self> {
        match s {
            "none" => Ok(Repeat::None),
            "daily" => Ok(Repeat::Daily),
            "weekdays" => Ok(Repeat::Weekdays),
            "weekly" => Ok(Repeat::Weekly),
            "monthly" => Ok(Repeat::Monthly),
            _ => Err(invalid(
                "reminder repeat must be none, daily, weekdays, weekly or monthly",
            )),
        }
    }
}

/// The user's choice: a local date and time, and how it repeats.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ReminderRule {
    pub local_date: NaiveDate,
    pub local_time: NaiveTime,
    pub repeat: Repeat,
}

/// The notification's snooze buttons: "10 min", "1 h", "Tomorrow".
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Snooze {
    Minutes10,
    Hour1,
    Tomorrow,
}

/// A reminder as stored (spec §4). Times are UTC Unix milliseconds, like every other
/// timestamp in the schema.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Reminder {
    pub note_id: String,
    pub rule: ReminderRule,
    /// The next occurrence of the rule (the anchor; a snooze never moves it).
    pub due_at: i64,
    pub snoozed_until: Option<i64>,
    /// The effective due time already notified, so a restart never repeats it.
    pub fired_at: Option<i64>,
}

impl Reminder {
    /// When the reminder is next due: the snooze if there is one, else `due_at`.
    pub fn effective_due(&self) -> i64 {
        self.snoozed_until.unwrap_or(self.due_at)
    }
}

/// One line of the manager's Reminders tab. The title is the note's real title: hiding
/// it behind "Private note" while the lock is on needs the lock state, which the shell
/// owns (ruling R1), so the shell masks `title` when `private` and the lock is engaged.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReminderRow {
    pub note_id: String,
    pub title: String,
    pub color: String,
    pub private: bool,
    /// The note's neutral label, or "Private note" when it has none: what the manager
    /// shows instead of `title` while `locked` (owner decision 2026-11-09).
    pub locked_label: String,
    pub repeat: Repeat,
    /// UTC ms; the snooze if there is one, else the occurrence.
    pub effective_due: i64,
    /// `effective_due <= now`: due and not dismissed or rescheduled yet.
    pub overdue: bool,
    /// The lock currently withholds this private note: the shell shows `locked_label`
    /// instead of `title`, and the core's search matched that label, not the title.
    pub locked: bool,
    /// The note is archived: it has no window, so the manager shows it in Archived.
    pub archived: bool,
}

/// What a reminder's notification may say about its note: the real title and whether
/// the lock withholds the note right now (the same rule as [`ReminderRow::locked`]). The
/// shell shows "Private note" instead of `title` exactly when `locked` (ruling R6).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReminderHeading {
    pub title: String,
    pub locked: bool,
}

/// The refusal for a one-off in the past. The shell shows it without the error prefix.
pub const PAST_REMINDER: &str = "Pick a time in the future.";
/// The refusal for a reminder more than 100 years away.
pub const FAR_REMINDER: &str = "This reminder is too far away.";

/// Stored and accepted reminder instants lie within this span of "now" (spec §4: ±100 years).
const MAX_SPAN_MS: i64 = 100 * 366 * 24 * 3600 * 1000;

/// Whether `at_ms` is within ±100 years of `now_ms`.
pub fn within_range(at_ms: i64, now_ms: i64) -> bool {
    at_ms
        .checked_sub(now_ms)
        .is_some_and(|d| d.abs() <= MAX_SPAN_MS)
}

/// The rule's own date and time in `tz`, with the DST gap and overlap rules applied.
pub fn first_due<Tz: TimeZone>(rule: &ReminderRule, tz: &Tz) -> DateTime<Utc> {
    resolve_local(rule.local_date.and_time(rule.local_time), tz)
}

/// The first occurrence strictly after `after`, or `None` for a one-off that is
/// already past (or when no occurrence fits before the end of year 9999).
///
/// The search starts at the later of the rule's date and the local date of `after`
/// minus one day (a margin for DST gaps near midnight), so a rule picked years ago
/// costs the same as a new one.
pub fn next_occurrence<Tz: TimeZone>(
    rule: &ReminderRule,
    after: DateTime<Utc>,
    tz: &Tz,
) -> Option<DateTime<Utc>> {
    if rule.repeat == Repeat::None {
        let due = first_due(rule, tz);
        return (due > after).then_some(due);
    }
    let after_date = local_date(after, tz)?;
    // One day back as a margin: a DST gap just before midnight can push the previous
    // local date's occurrence past `after`.
    let mut date = rule
        .local_date
        .max(after_date.pred_opt().unwrap_or(after_date));
    for _ in 0..SEARCH_DAYS {
        if date.year() > LAST_YEAR {
            return None;
        }
        if occurs_on(rule, date) {
            let due = resolve_local(date.and_time(rule.local_time), tz);
            if due > after {
                return Some(due);
            }
        }
        date = date.succ_opt()?;
    }
    None
}

/// When a snoozed reminder fires again. Never changes the rule: "10 min" and "1 h"
/// count from `now`; "Tomorrow" is tomorrow's local date at the rule's wall-clock time.
pub fn snooze<Tz: TimeZone>(
    now: DateTime<Utc>,
    by: Snooze,
    rule: &ReminderRule,
    tz: &Tz,
) -> DateTime<Utc> {
    let plus = |delta: TimeDelta| {
        now.checked_add_signed(delta)
            .unwrap_or(DateTime::<Utc>::MAX_UTC)
    };
    match by {
        Snooze::Minutes10 => plus(TimeDelta::minutes(10)),
        Snooze::Hour1 => plus(TimeDelta::hours(1)),
        Snooze::Tomorrow => match local_date(now, tz).and_then(|d| d.succ_opt()) {
            Some(tomorrow) => resolve_local(tomorrow.and_time(rule.local_time), tz),
            None => plus(TimeDelta::days(1)),
        },
    }
}

/// Parse the user's choice: `YYYY-MM-DD` (a real calendar date), `HH:MM` (24 h,
/// two digits each) and one of the five repeat names. Whether the time is in the
/// future is checked by the caller, which knows `now`.
pub fn validate_rule(date: &str, time: &str, repeat: &str) -> CoreResult<ReminderRule> {
    Ok(ReminderRule {
        local_date: parse_date(date)?,
        local_time: parse_time(time)?,
        repeat: repeat.parse()?,
    })
}

fn parse_date(s: &str) -> CoreResult<NaiveDate> {
    let b = s.as_bytes();
    let shape = b.len() == 10
        && b[4] == b'-'
        && b[7] == b'-'
        && b.iter()
            .enumerate()
            .all(|(i, c)| i == 4 || i == 7 || c.is_ascii_digit());
    if !shape {
        return Err(invalid("reminder date must be YYYY-MM-DD"));
    }
    let num = |r: std::ops::Range<usize>| s[r].parse::<u32>().unwrap_or(0);
    NaiveDate::from_ymd_opt(num(0..4) as i32, num(5..7), num(8..10))
        .ok_or_else(|| invalid("reminder date does not exist"))
}

fn parse_time(s: &str) -> CoreResult<NaiveTime> {
    let b = s.as_bytes();
    let shape = b.len() == 5
        && b[2] == b':'
        && b.iter()
            .enumerate()
            .all(|(i, c)| i == 2 || c.is_ascii_digit());
    if !shape {
        return Err(invalid("reminder time must be HH:MM"));
    }
    let num = |r: std::ops::Range<usize>| s[r].parse::<u32>().unwrap_or(99);
    NaiveTime::from_hms_opt(num(0..2), num(3..5), 0)
        .ok_or_else(|| invalid("reminder time must be between 00:00 and 23:59"))
}

/// Whether a repeating rule has an occurrence on this local date.
fn occurs_on(rule: &ReminderRule, date: NaiveDate) -> bool {
    match rule.repeat {
        Repeat::None => date == rule.local_date,
        Repeat::Daily => true,
        Repeat::Weekdays => !matches!(date.weekday(), Weekday::Sat | Weekday::Sun),
        Repeat::Weekly => date.weekday() == rule.local_date.weekday(),
        // The anchor's day, or the month's last day when the month is shorter; the
        // anchor is always the rule's own day, so 31 → 30 Apr → 31 May.
        Repeat::Monthly => date.day() == rule.local_date.day().min(days_in_month(date)),
    }
}

fn days_in_month(date: NaiveDate) -> u32 {
    let (y, m) = if date.month() == 12 {
        (date.year() + 1, 1)
    } else {
        (date.year(), date.month() + 1)
    };
    NaiveDate::from_ymd_opt(y, m, 1)
        .and_then(|first| first.pred_opt())
        .map_or(31, |last| last.day())
}

/// The local calendar date of an instant, or `None` past the representable range.
fn local_date<Tz: TimeZone>(at: DateTime<Utc>, tz: &Tz) -> Option<NaiveDate> {
    if at.year() > LAST_YEAR {
        return None;
    }
    let offset = tz.offset_from_utc_datetime(&at.naive_utc()).fix();
    at.naive_utc()
        .checked_add_signed(TimeDelta::seconds(offset.local_minus_utc().into()))
        .map(|local| local.date())
}

/// A local wall-clock time as an instant: the earliest instance in an overlap, the
/// first valid minute after a gap.
fn resolve_local<Tz: TimeZone>(local: NaiveDateTime, tz: &Tz) -> DateTime<Utc> {
    if let Some(at) = earliest(local, tz) {
        return at;
    }
    after_gap(local, tz).unwrap_or_else(|| {
        // No valid time within two days: no real zone does this. Read the wall clock
        // with the offset in force at that moment rather than fail.
        let offset = tz.offset_from_utc_datetime(&local).fix();
        let utc = local
            .checked_sub_signed(TimeDelta::seconds(offset.local_minus_utc().into()))
            .unwrap_or(local);
        utc.and_utc()
    })
}

fn earliest<Tz: TimeZone>(local: NaiveDateTime, tz: &Tz) -> Option<DateTime<Utc>> {
    tz.from_local_datetime(&local)
        .earliest()
        .map(|at| at.to_utc())
}

/// The first valid minute after `local`, which falls in a gap. Steps forward an hour
/// at a time, then bisects the minutes of the hour where the gap ends.
fn after_gap<Tz: TimeZone>(local: NaiveDateTime, tz: &Tz) -> Option<DateTime<Utc>> {
    let mut start = local; // not valid
    for _ in 0..GAP_SEARCH_HOURS {
        let end = start.checked_add_signed(TimeDelta::hours(1))?;
        if earliest(end, tz).is_some() {
            // Invalid at `bad` minutes past `start`, valid at `good`.
            let (mut bad, mut good) = (0_i64, 60_i64);
            while good - bad > 1 {
                let mid = (bad + good) / 2;
                let at = start.checked_add_signed(TimeDelta::minutes(mid))?;
                if earliest(at, tz).is_some() {
                    good = mid;
                } else {
                    bad = mid;
                }
            }
            return earliest(start.checked_add_signed(TimeDelta::minutes(good))?, tz);
        }
        start = end;
    }
    None
}

fn invalid(msg: impl Into<String>) -> CoreError {
    CoreError::Validation(msg.into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{Datelike, FixedOffset, LocalResult, Timelike, Weekday};
    use chrono_tz::America::New_York;
    use chrono_tz::Europe::Paris;

    fn rule(date: &str, time: &str, repeat: &str) -> ReminderRule {
        validate_rule(date, time, repeat).expect("test rule must be valid")
    }

    /// A Paris wall-clock instant that exists exactly once.
    fn paris(y: i32, mo: u32, d: u32, h: u32, mi: u32) -> DateTime<Utc> {
        Paris
            .with_ymd_and_hms(y, mo, d, h, mi, 0)
            .single()
            .expect("unambiguous Paris time")
            .to_utc()
    }

    fn utc(y: i32, mo: u32, d: u32, h: u32, mi: u32) -> DateTime<Utc> {
        Utc.with_ymd_and_hms(y, mo, d, h, mi, 0).unwrap()
    }

    /// A zone where no local time exists (every minute is in a gap), at UTC+2. No real
    /// zone does this; it drives `resolve_local`'s last fallback.
    #[derive(Clone)]
    struct NoLocalTimes;

    impl TimeZone for NoLocalTimes {
        type Offset = FixedOffset;
        fn from_offset(_: &FixedOffset) -> Self {
            NoLocalTimes
        }
        fn offset_from_local_date(&self, _: &NaiveDate) -> LocalResult<FixedOffset> {
            LocalResult::None
        }
        fn offset_from_local_datetime(&self, _: &NaiveDateTime) -> LocalResult<FixedOffset> {
            LocalResult::None
        }
        fn offset_from_utc_date(&self, _: &NaiveDate) -> FixedOffset {
            FixedOffset::east_opt(7200).unwrap()
        }
        fn offset_from_utc_datetime(&self, _: &NaiveDateTime) -> FixedOffset {
            FixedOffset::east_opt(7200).unwrap()
        }
    }

    #[test]
    fn a_local_time_no_zone_rule_resolves_reads_the_clock_with_the_offset_in_force() {
        let local = NaiveDate::from_ymd_opt(2026, 11, 4)
            .unwrap()
            .and_hms_opt(14, 0, 0)
            .unwrap();
        assert_eq!(resolve_local(local, &NoLocalTimes), utc(2026, 11, 4, 12, 0));
        // A rule in such a zone still gets a due time, and nothing panics.
        let once = rule("2026-11-04", "14:00", "none");
        assert_eq!(first_due(&once, &NoLocalTimes), utc(2026, 11, 4, 12, 0));
    }

    #[test]
    fn repeat_names_round_trip() {
        for (repeat, name) in [
            (Repeat::None, "none"),
            (Repeat::Daily, "daily"),
            (Repeat::Weekdays, "weekdays"),
            (Repeat::Weekly, "weekly"),
            (Repeat::Monthly, "monthly"),
        ] {
            assert_eq!(repeat.as_str(), name);
            assert_eq!(repeat.to_string(), name);
            assert_eq!(name.parse::<Repeat>().unwrap(), repeat);
            assert_eq!(
                serde_json::to_string(&repeat).unwrap(),
                format!("\"{name}\"")
            );
            assert_eq!(
                serde_json::from_str::<Repeat>(&format!("\"{name}\"")).unwrap(),
                repeat
            );
        }
        for bad in ["", "Daily", "hourly", " none", "none "] {
            let err = bad.parse::<Repeat>().unwrap_err();
            assert_eq!(err.code(), "validation", "{bad:?}");
        }
    }

    #[test]
    fn first_due_is_the_rule_wall_clock() {
        let r = rule("2026-11-04", "14:00", "none");
        assert_eq!(first_due(&r, &Paris), paris(2026, 11, 4, 14, 0));
        assert_eq!(first_due(&r, &Utc), utc(2026, 11, 4, 14, 0));
    }

    #[test]
    fn daily_next_occurrence() {
        let r = rule("2026-11-04", "09:00", "daily");
        // Before the first one: the first one.
        assert_eq!(
            next_occurrence(&r, paris(2026, 11, 1, 12, 0), &Paris),
            Some(paris(2026, 11, 4, 9, 0))
        );
        // Later the same day: tomorrow.
        assert_eq!(
            next_occurrence(&r, paris(2026, 11, 10, 9, 1), &Paris),
            Some(paris(2026, 11, 11, 9, 0))
        );
        // Earlier the same day: today.
        assert_eq!(
            next_occurrence(&r, paris(2026, 11, 10, 8, 59), &Paris),
            Some(paris(2026, 11, 10, 9, 0))
        );
    }

    #[test]
    fn next_occurrence_is_strictly_after() {
        let r = rule("2026-11-04", "09:00", "daily");
        let due = paris(2026, 11, 4, 9, 0);
        assert_eq!(
            next_occurrence(&r, due, &Paris),
            Some(paris(2026, 11, 5, 9, 0))
        );
        let once = rule("2026-11-04", "09:00", "none");
        assert_eq!(next_occurrence(&once, due, &Paris), None);
        assert_eq!(
            next_occurrence(&once, due - chrono::Duration::seconds(1), &Paris),
            Some(due)
        );
    }

    #[test]
    fn weekdays_next_occurrence() {
        // 2026-11-04 is a Wednesday.
        let r = rule("2026-11-04", "09:00", "weekdays");
        assert_eq!(
            next_occurrence(&r, paris(2026, 11, 4, 10, 0), &Paris),
            Some(paris(2026, 11, 5, 9, 0))
        );
        // Saturday and Sunday are skipped.
        assert_eq!(
            next_occurrence(&r, paris(2026, 11, 7, 8, 0), &Paris),
            Some(paris(2026, 11, 9, 9, 0))
        );
        assert_eq!(
            next_occurrence(&r, paris(2026, 11, 8, 10, 0), &Paris),
            Some(paris(2026, 11, 9, 9, 0))
        );
        // A weekday rule picked on a Saturday first fires on Monday.
        let sat = rule("2026-11-07", "09:00", "weekdays");
        assert_eq!(
            next_occurrence(&sat, paris(2026, 11, 1, 0, 0), &Paris),
            Some(paris(2026, 11, 9, 9, 0))
        );
    }

    #[test]
    fn weekly_next_occurrence() {
        let r = rule("2026-11-04", "09:00", "weekly");
        assert_eq!(
            next_occurrence(&r, paris(2026, 11, 4, 9, 0), &Paris),
            Some(paris(2026, 11, 11, 9, 0))
        );
        assert_eq!(
            next_occurrence(&r, paris(2026, 11, 12, 0, 0), &Paris),
            Some(paris(2026, 11, 18, 9, 0))
        );
        let next = next_occurrence(&r, paris(2027, 3, 1, 0, 0), &Paris).unwrap();
        assert_eq!(next.with_timezone(&Paris).weekday(), Weekday::Wed);
        assert_eq!(next, paris(2027, 3, 3, 9, 0));
    }

    #[test]
    fn monthly_next_occurrence() {
        let r = rule("2026-11-04", "09:00", "monthly");
        assert_eq!(
            next_occurrence(&r, paris(2026, 11, 4, 9, 0), &Paris),
            Some(paris(2026, 12, 4, 9, 0))
        );
        assert_eq!(
            next_occurrence(&r, paris(2026, 12, 20, 0, 0), &Paris),
            Some(paris(2027, 1, 4, 9, 0))
        );
    }

    #[test]
    fn next_occurrence_dst_and_month_end() {
        // Spring forward: 02:30 does not exist in Paris on 2026-03-29; it fires at 03:00
        // local (01:00 UTC), the first valid minute after the gap.
        let gap = rule("2026-03-29", "02:30", "none");
        assert_eq!(first_due(&gap, &Paris), utc(2026, 3, 29, 1, 0));
        assert_eq!(first_due(&gap, &Paris).with_timezone(&Paris).hour(), 3);
        let daily = rule("2026-03-20", "02:30", "daily");
        assert_eq!(
            next_occurrence(&daily, paris(2026, 3, 28, 12, 0), &Paris),
            Some(utc(2026, 3, 29, 1, 0))
        );
        assert_eq!(
            next_occurrence(&daily, utc(2026, 3, 29, 1, 0), &Paris),
            Some(paris(2026, 3, 30, 2, 30))
        );

        // Fall back: 02:30 happens twice on 2026-10-25 (00:30 and 01:30 UTC); only the first fires.
        let overlap = rule("2026-10-25", "02:30", "daily");
        assert_eq!(first_due(&overlap, &Paris), utc(2026, 10, 25, 0, 30));
        assert_eq!(
            next_occurrence(&overlap, utc(2026, 10, 24, 12, 0), &Paris),
            Some(utc(2026, 10, 25, 0, 30))
        );
        assert_eq!(
            next_occurrence(&overlap, utc(2026, 10, 25, 0, 30), &Paris),
            Some(paris(2026, 10, 26, 2, 30)),
            "the second 02:30 must not fire"
        );

        // Monthly on the 31st: 30 April, then back to 31 May (the clamp never sticks).
        let m31 = rule("2026-03-31", "09:00", "monthly");
        let apr = next_occurrence(&m31, paris(2026, 3, 31, 9, 0), &Paris).unwrap();
        assert_eq!(apr, paris(2026, 4, 30, 9, 0));
        let may = next_occurrence(&m31, apr, &Paris).unwrap();
        assert_eq!(may, paris(2026, 5, 31, 9, 0));
        assert_eq!(
            next_occurrence(&m31, may, &Paris),
            Some(paris(2026, 6, 30, 9, 0))
        );

        // Leap years: the 31st lands on 29 Feb in 2028, on 28 Feb in 2029.
        let jan31 = rule("2028-01-31", "09:00", "monthly");
        assert_eq!(
            next_occurrence(&jan31, paris(2028, 1, 31, 9, 0), &Paris),
            Some(paris(2028, 2, 29, 9, 0))
        );
        // A rule picked on 29 Feb 2028 fires on 28 Feb 2029, then back to 29 March.
        let feb29 = rule("2028-02-29", "09:00", "monthly");
        assert_eq!(
            next_occurrence(&feb29, paris(2028, 2, 29, 9, 0), &Paris),
            Some(paris(2028, 3, 29, 9, 0))
        );
        let feb = next_occurrence(&feb29, paris(2029, 1, 29, 9, 0), &Paris).unwrap();
        assert_eq!(feb, paris(2029, 2, 28, 9, 0));
        assert_eq!(
            next_occurrence(&feb29, feb, &Paris),
            Some(paris(2029, 3, 29, 9, 0))
        );
    }

    #[test]
    fn dst_gap_finds_the_first_valid_minute() {
        // Paris: exactly at the start of the gap.
        assert_eq!(
            first_due(&rule("2026-03-29", "02:00", "none"), &Paris),
            utc(2026, 3, 29, 1, 0)
        );
        // Lord Howe Island moves 02:00 → 02:30 (a half-hour gap) on 2026-10-04: 02:10
        // fires at 02:30 local, 15:30 UTC the day before (+10:30 → +11:00).
        let lhi = chrono_tz::Australia::Lord_Howe;
        let due = first_due(&rule("2026-10-04", "02:10", "none"), &lhi);
        assert_eq!(due, utc(2026, 10, 3, 15, 30));
        assert_eq!(
            due.with_timezone(&lhi).time(),
            NaiveTime::from_hms_opt(2, 30, 0).unwrap()
        );
    }

    #[test]
    fn snooze_keeps_anchor() {
        let r = rule("2026-11-02", "09:00", "weekdays");
        let fired = paris(2026, 11, 4, 9, 0); // Wednesday
        let later = snooze(fired, Snooze::Hour1, &r, &Paris);
        assert_eq!(later, paris(2026, 11, 4, 10, 0));
        assert_eq!(
            snooze(fired, Snooze::Minutes10, &r, &Paris),
            paris(2026, 11, 4, 9, 10)
        );
        // Dismissing after the snooze goes back to the 09:00 anchor, and the rule is unchanged.
        assert_eq!(
            next_occurrence(&r, later, &Paris),
            Some(paris(2026, 11, 5, 9, 0))
        );
        assert_eq!(r, rule("2026-11-02", "09:00", "weekdays"));
        // Snoozed at 09:47 to "Tomorrow": tomorrow at the rule's 09:00, not 09:47.
        let tomorrow = snooze(paris(2026, 11, 4, 9, 47), Snooze::Tomorrow, &r, &Paris);
        assert_eq!(tomorrow, paris(2026, 11, 5, 9, 0));
        assert_eq!(
            next_occurrence(&r, tomorrow, &Paris),
            Some(paris(2026, 11, 6, 9, 0))
        );
    }

    #[test]
    fn snooze_tomorrow_follows_the_local_date_and_dst() {
        let r = rule("2026-03-01", "02:30", "daily");
        // 23:30 UTC on the 27th is already the 28th in Paris, so "tomorrow" is the 29th,
        // where 02:30 does not exist: 03:00 local.
        assert_eq!(
            snooze(utc(2026, 3, 27, 23, 30), Snooze::Tomorrow, &r, &Paris),
            utc(2026, 3, 29, 1, 0)
        );
        // Across the fall-back day, the first 02:30 only.
        assert_eq!(
            snooze(paris(2026, 10, 24, 2, 40), Snooze::Tomorrow, &r, &Paris),
            utc(2026, 10, 25, 0, 30)
        );
        // Minutes are plain UTC arithmetic, whatever the wall clock does.
        assert_eq!(
            snooze(utc(2026, 3, 29, 0, 55), Snooze::Minutes10, &r, &Paris),
            utc(2026, 3, 29, 1, 5)
        );
    }

    #[test]
    fn dismiss_weekdays_on_friday() {
        let r = rule("2026-11-02", "09:00", "weekdays");
        let friday = paris(2026, 11, 6, 9, 0);
        assert_eq!(friday.with_timezone(&Paris).weekday(), Weekday::Fri);
        let next = next_occurrence(&r, friday, &Paris).unwrap();
        assert_eq!(next, paris(2026, 11, 9, 9, 0));
        assert_eq!(next.with_timezone(&Paris).weekday(), Weekday::Mon);
        // Snoozed to Saturday with "Tomorrow", a dismiss still lands on Monday.
        let sat = snooze(friday, Snooze::Tomorrow, &r, &Paris);
        assert_eq!(
            next_occurrence(&r, sat, &Paris),
            Some(paris(2026, 11, 9, 9, 0))
        );
    }

    #[test]
    fn one_off_in_the_past_is_none() {
        let r = rule("2026-11-04", "09:00", "none");
        assert_eq!(next_occurrence(&r, paris(2026, 11, 4, 9, 1), &Paris), None);
        assert_eq!(next_occurrence(&r, paris(2030, 1, 1, 0, 0), &Paris), None);
        assert_eq!(
            next_occurrence(&r, paris(2026, 11, 3, 9, 0), &Paris),
            Some(paris(2026, 11, 4, 9, 0))
        );
    }

    #[test]
    fn time_zone_change_keeps_wall_clock() {
        let r = rule("2026-11-02", "09:00", "daily");
        let after = utc(2026, 11, 4, 12, 0);
        let in_paris = next_occurrence(&r, after, &Paris).unwrap();
        let in_ny = next_occurrence(&r, after, &New_York).unwrap();
        // 09:00 Paris (08:00 UTC) is already past at noon UTC; 09:00 New York (14:00 UTC) is not.
        assert_eq!(in_paris, utc(2026, 11, 5, 8, 0));
        assert_eq!(in_ny, utc(2026, 11, 4, 14, 0));
        for (due, wall) in [
            (in_paris.with_timezone(&Paris).time(), "Paris"),
            (in_ny.with_timezone(&New_York).time(), "New York"),
        ] {
            assert_eq!(due, NaiveTime::from_hms_opt(9, 0, 0).unwrap(), "{wall}");
        }
        assert_eq!(first_due(&r, &New_York).with_timezone(&New_York).hour(), 9);
    }

    #[test]
    fn far_past_rules_and_far_future_after_are_bounded() {
        let old = rule("1970-01-01", "09:00", "weekly"); // a Thursday
        assert_eq!(
            next_occurrence(&old, paris(2026, 11, 4, 12, 0), &Paris),
            Some(paris(2026, 11, 5, 9, 0))
        );
        let old_monthly = rule("1900-01-31", "09:00", "monthly");
        assert_eq!(
            next_occurrence(&old_monthly, paris(2026, 2, 1, 0, 0), &Paris),
            Some(paris(2026, 2, 28, 9, 0))
        );
        let daily = rule("2026-11-04", "09:00", "daily");
        let far = utc(9000, 6, 1, 0, 0);
        assert_eq!(
            next_occurrence(&daily, far, &Utc),
            Some(utc(9000, 6, 1, 9, 0))
        );
        // At the very end of time there is no next occurrence, and nothing panics.
        assert_eq!(
            next_occurrence(&daily, DateTime::<Utc>::MAX_UTC, &Paris),
            None
        );
        assert_eq!(
            next_occurrence(&daily, DateTime::<Utc>::MAX_UTC, &Utc),
            None
        );
    }

    #[test]
    fn validate_rule_accepts_and_refuses() {
        let r = validate_rule("2026-11-04", "14:00", "weekly").unwrap();
        assert_eq!(r.local_date, NaiveDate::from_ymd_opt(2026, 11, 4).unwrap());
        assert_eq!(r.local_time, NaiveTime::from_hms_opt(14, 0, 0).unwrap());
        assert_eq!(r.repeat, Repeat::Weekly);
        assert!(validate_rule("2028-02-29", "00:00", "none").is_ok());
        assert!(validate_rule("2026-12-31", "23:59", "monthly").is_ok());
        for (date, time, repeat) in [
            ("2026-02-30", "09:00", "none"),
            ("2027-02-29", "09:00", "none"),
            ("2026-13-01", "09:00", "none"),
            ("2026-11-4", "09:00", "none"),
            ("26-11-04", "09:00", "none"),
            ("2026/11/04", "09:00", "none"),
            (" 2026-11-04", "09:00", "none"),
            ("+2026-11-04", "09:00", "none"),
            ("", "09:00", "none"),
            ("2026-11-04", "24:00", "none"),
            ("2026-11-04", "9:5", "none"),
            ("2026-11-04", "9:05", "none"),
            ("2026-11-04", "09:60", "none"),
            ("2026-11-04", "09:00:00", "none"),
            ("2026-11-04", "+9:00", "none"),
            ("2026-11-04", "", "none"),
            ("2026-11-04", "09:00", "hourly"),
            ("2026-11-04", "09:00", "Daily"),
            ("2026-11-04", "09:00", ""),
        ] {
            let err = validate_rule(date, time, repeat).unwrap_err();
            assert_eq!(err.code(), "validation", "{date:?} {time:?} {repeat:?}");
        }
    }
}
