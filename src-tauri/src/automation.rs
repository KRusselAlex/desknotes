//! Automation rules (DES-42) in the shell: when rules 3 and 4 run, and what rule 2
//! does when a repeating reminder goes off. The core owns what each rule changes
//! (`desknotes_core::db::automation`); this module only decides when, and tells
//! the windows.
//!
//! Rules 3 (archive done notes) and 4 (empty old trash) run once at start-up, before
//! any window shows, then once an hour on their own thread, and again right after the
//! settings change or the privacy lock is unlocked. A run never blocks the main
//! thread after start-up, logs counts and errors only (never note text) and sends
//! `notes-changed` when it changed something.

use std::time::Duration;

use desknotes_core::db::cutoff_ms;
use desknotes_core::{CoreResult, Database, now_ms};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::state::{AppState, DATABASE_UNAVAILABLE};
use crate::windows::{self, emit_changed};

/// The rule settings were saved (payload: the saved `Automations`, every window).
pub const AUTOMATIONS_CHANGED: &str = "automations-changed";
/// A note's repeating reminder went off: the open note window unticks its checklist
/// in the editor (payload `{ noteId }`, sent to that note's window only).
pub const CHECKLIST_RESET: &str = "checklist-reset";

/// How often rules 3 and 4 run while DeskNotes is open.
const PERIOD: Duration = Duration::from_secs(3600);

/// What one run of rules 3 and 4 changed.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct RuleCounts {
    pub archived: usize,
    pub purged: usize,
}

impl RuleCounts {
    fn any(self) -> bool {
        self.archived > 0 || self.purged > 0
    }
}

/// Rule 3 then rule 4, each only when on, with the cutoffs taken from `now_ms`.
pub fn run_rules(db: &Database, now_ms: i64) -> CoreResult<RuleCounts> {
    let rules = db.automations()?;
    let mut counts = RuleCounts::default();
    if rules.archive_done_enabled {
        counts.archived = db.archive_done_before(cutoff_ms(now_ms, rules.archive_done_days))?;
    }
    if rules.purge_trash_enabled {
        counts.purged = db.purge_trashed_before(cutoff_ms(now_ms, rules.purge_trash_days))?;
    }
    Ok(counts)
}

/// Run rules 3 and 4 now, on this thread, and tell the windows if anything changed.
fn apply(app: &AppHandle) {
    let Some(state) = app.try_state::<AppState>() else {
        return;
    };
    match state.with_db(|db| run_rules(db, now_ms())) {
        Ok(counts) if counts.any() => {
            eprintln!(
                "DeskNotes: automation rules archived {} and deleted {} notes",
                counts.archived, counts.purged
            );
            emit_changed(app, None, "other");
        }
        Ok(_) => {}
        // Already reported at start-up; nothing to add every hour.
        Err(e) if e.code == DATABASE_UNAVAILABLE => {}
        Err(e) => eprintln!("DeskNotes: automation rules could not run: {}", e.code),
    }
}

/// Run rules 3 and 4 once now (before any window shows), then every hour on a
/// background thread. Call once, right after the database opened.
pub fn start(app: &AppHandle) {
    apply(app);
    let handle = app.clone();
    let spawned = std::thread::Builder::new()
        .name("desknotes-automations".into())
        .spawn(move || {
            loop {
                std::thread::sleep(PERIOD);
                apply(&handle);
            }
        });
    if let Err(e) = spawned {
        eprintln!("DeskNotes: the automation rules could not start: {e}");
    }
}

/// Run rules 3 and 4 once, on another thread (after the settings changed or the
/// privacy lock was unlocked). Never blocks the caller.
pub fn run_soon(app: &AppHandle) {
    let handle = app.clone();
    let spawned = std::thread::Builder::new()
        .name("desknotes-automations-now".into())
        .spawn(move || apply(&handle));
    if let Err(e) = spawned {
        eprintln!("DeskNotes: the automation rules could not run: {e}");
    }
}

/// What rule 2 does for one reminder fire.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResetAction {
    /// The note's window is open: it unticks in the editor (one undoable step).
    Emit,
    /// No window: the core unticks the stored note.
    WriteDb,
    Nothing,
}

/// Rule 2's decision, from whether the note's window exists and whether the core
/// says this fire resets the checklist ([`Database::checklist_reset_due`]).
pub fn reset_action(window_exists: bool, due: bool) -> ResetAction {
    match (due, window_exists) {
        (false, _) => ResetAction::Nothing,
        (true, true) => ResetAction::Emit,
        (true, false) => ResetAction::WriteDb,
    }
}

/// Rule 2 against the database, under one lock: ask the core, and untick the
/// stored note when no window is open. Returns what is left for the shell to do:
/// [`ResetAction::Emit`] (tell the window), [`ResetAction::WriteDb`] (the stored
/// note was unticked) or [`ResetAction::Nothing`].
pub fn react_to_fire(
    db: &Database,
    note_id: &str,
    fired_due: i64,
    window_exists: bool,
) -> CoreResult<ResetAction> {
    let action = reset_action(window_exists, db.checklist_reset_due(note_id, fired_due)?);
    if action == ResetAction::WriteDb && !db.untick_checklist(note_id)? {
        return Ok(ResetAction::Nothing);
    }
    Ok(action)
}

/// Payload of `checklist-reset`.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ChecklistReset {
    note_id: String,
}

/// A reminder fire was recorded (`mark_fired(note_id, fired_due)` succeeded for a
/// fire `due_reminders` produced). `fired_due` is that occurrence's effective due
/// time, as given to `mark_fired`. Rule 2 unticks the note's checklist when the core
/// says so. Runs on the reminder thread: never waits for a window; errors are logged.
pub fn on_fired(app: &AppHandle, note_id: &str, fired_due: i64) {
    let Some(state) = app.try_state::<AppState>() else {
        return;
    };
    let label = windows::note_label(note_id);
    let window_exists = app.get_webview_window(&label).is_some();
    match state.with_db(|db| react_to_fire(db, note_id, fired_due, window_exists)) {
        Ok(ResetAction::Emit) => {
            let payload = ChecklistReset {
                note_id: note_id.to_owned(),
            };
            if let Err(e) = app.emit_to(label.as_str(), CHECKLIST_RESET, payload) {
                eprintln!("DeskNotes: could not ask a note to reset its checklist: {e}");
            }
        }
        Ok(ResetAction::WriteDb) => emit_changed(app, Some(note_id), "content"),
        Ok(ResetAction::Nothing) => {}
        Err(e) => eprintln!("DeskNotes: a checklist could not be reset: {}", e.code),
    }
}

#[cfg(test)]
mod tests {
    use chrono::Utc;
    use desknotes_core::db::Automations;
    use desknotes_core::reminders::validate_rule;
    use serde_json::json;

    use super::*;

    const DAY_MS: i64 = 86_400_000;

    fn db() -> Database {
        Database::open_in_memory().unwrap()
    }

    fn rules(db: &Database, archive: bool, purge: bool) {
        db.set_automations(&Automations {
            archive_done_enabled: archive,
            archive_done_days: 7,
            purge_trash_enabled: purge,
            purge_trash_days: 30,
            ..db.automations().unwrap()
        })
        .unwrap();
    }

    /// Notes as seen from a run 31 days from now (rules take `now` as given): one
    /// done 8 days before it, one done 6 days before it, one trashed today (31 days
    /// before it) and one active note. Returns the run's `now`.
    fn seed(db: &Database) -> i64 {
        let run_at = now_ms() + 31 * DAY_MS;
        for days in [8, 6] {
            let id = db.create_note(None).unwrap().id;
            db.set_completed(&id, true, run_at - days * DAY_MS).unwrap();
        }
        let trashed = db.create_note(None).unwrap().id;
        db.trash_note(&trashed).unwrap();
        db.create_note(None).unwrap();
        run_at
    }

    #[test]
    fn run_rules_with_both_rules_off_changes_nothing() {
        let db = db();
        let run_at = seed(&db);
        assert_eq!(run_rules(&db, run_at).unwrap(), RuleCounts::default());
    }

    #[test]
    fn run_rules_with_both_rules_on_gives_the_counts() {
        let db = db();
        let run_at = seed(&db);
        rules(&db, true, true);
        // Two days earlier nothing is old enough yet (6, 4 and 29 days).
        assert_eq!(
            run_rules(&db, run_at - 2 * DAY_MS).unwrap(),
            RuleCounts::default()
        );
        assert_eq!(
            run_rules(&db, run_at).unwrap(),
            RuleCounts {
                archived: 1,
                purged: 1
            }
        );
        assert_eq!(run_rules(&db, run_at).unwrap(), RuleCounts::default());
    }

    #[test]
    fn run_rules_runs_only_the_rules_that_are_on() {
        let db = db();
        let run_at = seed(&db);
        rules(&db, true, false);
        assert_eq!(
            run_rules(&db, run_at).unwrap(),
            RuleCounts {
                archived: 1,
                purged: 0
            }
        );
        rules(&db, false, true);
        assert_eq!(
            run_rules(&db, run_at).unwrap(),
            RuleCounts {
                archived: 0,
                purged: 1
            }
        );
    }

    #[test]
    fn open_window_gets_the_event_not_a_db_write() {
        assert_eq!(reset_action(true, true), ResetAction::Emit);
        assert_eq!(reset_action(false, true), ResetAction::WriteDb);
        assert_eq!(reset_action(true, false), ResetAction::Nothing);
        assert_eq!(reset_action(false, false), ResetAction::Nothing);
    }

    /// A note with one ticked and one unticked item and a daily reminder; rule 2 on.
    /// Returns the note id and the reminder's `due_at`.
    fn routine(db: &Database) -> (String, i64) {
        db.set_automations(&Automations {
            reset_checklists_on_repeat: true,
            ..db.automations().unwrap()
        })
        .unwrap();
        let id = db.create_note(None).unwrap().id;
        let item = |text: &str, checked: bool| {
            json!({"type":"taskItem","attrs":{"checked":checked},"content":[
                {"type":"paragraph","content":[{"type":"text","text":text}]}]})
        };
        let doc = json!({"type":"doc","content":[
            {"type":"paragraph","content":[{"type":"text","text":"Morning"}]},
            {"type":"taskList","content":[item("a", true), item("b", false)]}]});
        db.save_content(&id, &doc.to_string()).unwrap();
        let rule = validate_rule("2026-01-01", "09:00", "daily").unwrap();
        let r = db.set_reminder(&id, rule, Utc::now(), &Utc).unwrap();
        (id, r.due_at)
    }

    fn ticked(db: &Database, id: &str) -> bool {
        db.get_note(id)
            .unwrap()
            .content
            .to_string()
            .contains("\"checked\":true")
    }

    #[test]
    fn react_to_fire_unticks_the_stored_note_only_without_a_window() {
        let db = db();
        let (id, due) = routine(&db);

        // Window open: the editor unticks, the stored note is left alone.
        assert_eq!(
            react_to_fire(&db, &id, due, true).unwrap(),
            ResetAction::Emit
        );
        assert!(ticked(&db, &id));

        // A snoozed fire (not the occurrence's due_at) does nothing.
        assert_eq!(
            react_to_fire(&db, &id, due + 600_000, false).unwrap(),
            ResetAction::Nothing
        );
        assert!(ticked(&db, &id));

        // Window closed: the core unticks the stored note.
        assert_eq!(
            react_to_fire(&db, &id, due, false).unwrap(),
            ResetAction::WriteDb
        );
        assert!(!ticked(&db, &id));
        // Nothing left to untick.
        assert_eq!(
            react_to_fire(&db, &id, due, false).unwrap(),
            ResetAction::Nothing
        );
    }

    #[test]
    fn checklist_reset_payload_names_the_note_only() {
        let p = ChecklistReset {
            note_id: "n1".into(),
        };
        assert_eq!(serde_json::to_value(p).unwrap(), json!({ "noteId": "n1" }));
    }
}
