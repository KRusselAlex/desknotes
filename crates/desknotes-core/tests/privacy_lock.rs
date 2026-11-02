//! Enforcement of the privacy lock in the core (design D1, D2, D12, §4.3-4.4):
//! while the lock is on and a PIN exists, no caller can read a private note's
//! text, find it by its text, or destroy or copy it.

use desknotes_core::validation::empty_doc;
use desknotes_core::{Database, NoteFilter, PRIVATE_FALLBACK_LABEL};

const PIN: &str = "482913";

fn doc(text: &str) -> String {
    serde_json::json!({"type":"doc","content":[{"type":"paragraph","content":[
        {"type":"text","text":text}]}]})
    .to_string()
}

fn db_with_pin() -> Database {
    let db = Database::open_in_memory().unwrap();
    db.set_new_pin(PIN).unwrap();
    db
}

/// A private note labelled `label` whose text is `text`.
fn private_note(db: &Database, text: &str, label: &str) -> String {
    let id = db.create_note(Some("#ffd6e0")).unwrap().id;
    db.save_content(&id, &doc(text)).unwrap();
    db.set_private(&id, true, label).unwrap();
    id
}

fn ids(db: &Database, filter: NoteFilter, query: Option<&str>) -> Vec<String> {
    db.list_notes(filter, query)
        .unwrap()
        .into_iter()
        .map(|n| n.id)
        .collect()
}

#[test]
fn database_stays_send() {
    fn assert_send<T: Send>() {}
    assert_send::<Database>();
}

#[test]
fn locked_private_note_is_redacted_everywhere() {
    let db = db_with_pin();
    let id = private_note(&db, "Passport number 12AB34567", "Bank");
    db.set_privacy_locked(true, &[]);
    assert!(db.privacy_locked());
    assert!(db.is_note_locked(&id).unwrap());

    let note = db.get_note(&id).unwrap();
    assert_eq!(note.content, empty_doc());
    assert_eq!(note.title, "Bank");
    assert!(note.locked);
    assert!(note.private);
    assert_eq!(note.color, "#ffd6e0", "colour stays visible (D2)");

    let (shown, unreadable) = db.notes_to_show().unwrap();
    assert!(unreadable.is_empty());
    assert_eq!(shown.len(), 1);
    assert_eq!(shown[0].content, empty_doc());
    assert_eq!(shown[0].title, "Bank");
    assert!(shown[0].locked);

    for query in [None, Some("bank")] {
        let rows = db.list_notes(NoteFilter::Active, query).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].title, "Bank");
        assert!(rows[0].snippet.is_none());
        assert!(rows[0].locked);
    }

    // Nothing serialised for the webview carries the text.
    let json = serde_json::to_string(&db.get_note(&id).unwrap()).unwrap();
    assert!(!json.to_lowercase().contains("passport"), "{json}");
    let json = serde_json::to_string(&db.list_notes(NoteFilter::Active, None).unwrap()).unwrap();
    assert!(!json.to_lowercase().contains("passport"), "{json}");
}

#[test]
fn unlabelled_private_note_shows_fallback() {
    let db = db_with_pin();
    let id = private_note(&db, "Secret plans", "");
    db.set_privacy_locked(true, &[]);
    assert_eq!(db.get_note(&id).unwrap().title, PRIVATE_FALLBACK_LABEL);
    assert_eq!(
        db.list_notes(NoteFilter::Active, None).unwrap()[0].title,
        PRIVATE_FALLBACK_LABEL
    );
}

#[test]
fn search_does_not_see_locked_text() {
    let db = db_with_pin();
    let id = private_note(&db, "My passport is in the drawer", "Bank");
    db.set_privacy_locked(true, &[]);
    assert!(ids(&db, NoteFilter::Active, Some("passport")).is_empty());
    assert!(
        ids(&db, NoteFilter::Active, Some("my passport")).is_empty(),
        "the derived title is not searchable either"
    );
    assert_eq!(ids(&db, NoteFilter::Active, Some("Bank")), vec![id.clone()]);
    assert_eq!(ids(&db, NoteFilter::Active, Some("ank")), vec![id.clone()]);

    // Archived and trashed private notes are just as hidden.
    db.set_archived(&id, true).unwrap();
    assert!(ids(&db, NoteFilter::Archived, Some("passport")).is_empty());
    assert_eq!(
        ids(&db, NoteFilter::Archived, Some("bank")),
        vec![id.clone()]
    );
    db.trash_note(&id).unwrap();
    assert!(ids(&db, NoteFilter::Trash, Some("drawer")).is_empty());

    // Unlocking makes the text searchable again.
    db.set_privacy_locked(false, &[]);
    let rows = db.list_notes(NoteFilter::Trash, Some("passport")).unwrap();
    assert_eq!(rows.len(), 1);
    assert!(!rows[0].locked);
    assert!(rows[0].snippet.as_deref().unwrap().contains("passport"));
}

#[test]
fn locked_private_notes_cannot_be_saved_copied_or_destroyed() {
    let db = db_with_pin();
    let id = private_note(&db, "keep me", "Bank");
    db.trash_note(&id).unwrap();
    db.set_privacy_locked(true, &[]);

    let err = db.save_content(&id, &doc("overwritten")).unwrap_err();
    assert_eq!(err.code(), "not_allowed");
    assert_eq!(
        err.to_string(),
        "operation not allowed: private notes are locked"
    );
    assert_eq!(db.duplicate_note(&id).unwrap_err().code(), "not_allowed");
    assert_eq!(db.purge_note(&id).unwrap_err().code(), "not_allowed");
    assert_eq!(
        db.set_private(&id, false, "Bank").unwrap_err().code(),
        "not_allowed"
    );

    // Nothing changed underneath, and allowed actions still work (D12).
    db.set_color(&id, "#cfe8ff").unwrap();
    db.restore_note(&id).unwrap();
    db.set_window_geometry(&id, Some((5.0, 6.0)), 320.0, 300.0)
        .unwrap();
    db.set_privacy_locked(false, &[]);
    let note = db.get_note(&id).unwrap();
    assert_eq!(note.title, "keep me");
    assert!(note.private);
    assert_eq!(db.count_all_notes().unwrap(), 1, "no copy was made");
}

#[test]
fn export_and_restore_need_unlock_when_private_notes_exist() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open(&dir.path().join("d.db"), dir.path()).unwrap();
    db.set_new_pin(PIN).unwrap();
    db.create_note(None).unwrap();
    let backup = db.export_backup("0.1.0").unwrap().backup;

    // Locked with no private notes: both still work.
    db.set_privacy_locked(true, &[]);
    db.export_backup("0.1.0").unwrap();
    db.restore_backup(&backup, &dir.path().join("b1")).unwrap();

    // A private note anywhere (even in the trash) makes both ask for the PIN.
    let id = private_note(&db, "secret", "");
    db.trash_note(&id).unwrap();
    assert_eq!(
        db.export_backup("0.1.0").err().unwrap().code(),
        "not_allowed"
    );
    let safety = dir.path().join("b2");
    assert_eq!(
        db.restore_backup(&backup, &safety).unwrap_err().code(),
        "not_allowed"
    );
    assert!(!safety.exists(), "refused before writing anything");
    assert_eq!(db.count_all_notes().unwrap(), 2);

    db.set_privacy_locked(false, &[]);
    let export = db.export_backup("0.1.0").unwrap();
    assert_eq!(export.backup.notes.len(), 2);
}

#[test]
fn normal_notes_are_untouched_while_locked() {
    let db = db_with_pin();
    let private = private_note(&db, "hidden words", "Bank");
    let normal = db.create_note(None).unwrap().id;
    db.save_content(&normal, &doc("Shopping list: milk"))
        .unwrap();
    db.set_privacy_locked(true, &[]);

    assert!(!db.is_note_locked(&normal).unwrap());
    let note = db.get_note(&normal).unwrap();
    assert_eq!(note.title, "Shopping list: milk");
    assert!(!note.locked);
    assert_ne!(note.content, empty_doc());
    db.save_content(&normal, &doc("Shopping list: eggs"))
        .unwrap();
    let rows = db.list_notes(NoteFilter::Active, Some("eggs")).unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].id, normal);
    assert!(rows[0].snippet.is_some());
    let copy = db.duplicate_note(&normal).unwrap();
    assert!(!copy.private);
    db.trash_note(&copy.id).unwrap();
    db.purge_note(&copy.id).unwrap();

    let (shown, _) = db.notes_to_show().unwrap();
    let shown_private = shown.iter().find(|n| n.id == private).unwrap();
    assert!(shown_private.locked);
    assert!(!shown.iter().find(|n| n.id == normal).unwrap().locked);
}

#[test]
fn kept_open_note_saves_until_released() {
    let db = db_with_pin();
    let kept = private_note(&db, "draft one", "Diary");
    let other = private_note(&db, "other secret", "Bank");
    db.set_privacy_locked(true, std::slice::from_ref(&kept));

    assert!(!db.is_note_locked(&kept).unwrap());
    assert!(db.is_note_locked(&other).unwrap());
    db.save_content(&kept, &doc("draft two")).unwrap();
    let note = db.get_note(&kept).unwrap();
    assert_eq!(note.title, "draft two");
    assert!(!note.locked);

    // Locking again while locked can never make another note readable.
    db.set_privacy_locked(true, &[kept.clone(), other.clone()]);
    assert!(db.is_note_locked(&other).unwrap());
    assert!(!db.is_note_locked(&kept).unwrap());

    db.release_kept_open(&kept);
    assert!(db.is_note_locked(&kept).unwrap());
    assert_eq!(
        db.save_content(&kept, &doc("draft three"))
            .unwrap_err()
            .code(),
        "not_allowed"
    );
    assert_eq!(db.get_note(&kept).unwrap().title, "Diary");

    // Unlocking clears the kept-open list; the next lock starts fresh.
    db.set_privacy_locked(false, &[]);
    assert_eq!(db.get_note(&kept).unwrap().title, "draft two");
    db.set_privacy_locked(true, &[]);
    assert!(db.is_note_locked(&kept).unwrap());
}

#[test]
fn no_pin_means_no_lock() {
    let db = Database::open_in_memory().unwrap();
    let id = private_note(&db, "passport", "Bank");
    db.set_privacy_locked(true, &[]);
    assert!(!db.privacy_locked());
    assert!(!db.is_note_locked(&id).unwrap());
    let note = db.get_note(&id).unwrap();
    assert_eq!(note.title, "passport");
    assert!(!note.locked);
    assert_eq!(
        ids(&db, NoteFilter::Active, Some("passport")),
        vec![id.clone()]
    );
    db.save_content(&id, &doc("passport renewed")).unwrap();
    db.export_backup("0.1.0").unwrap();
}

#[test]
fn copy_of_a_private_note_stays_private() {
    let db = db_with_pin();
    let id = private_note(&db, "account details", "Bank");
    let copy = db.duplicate_note(&id).unwrap();
    assert!(copy.private);
    assert_eq!(copy.private_label, "Bank");
    assert_eq!(copy.title, "account details");

    db.set_privacy_locked(true, &[]);
    assert!(db.is_note_locked(&copy.id).unwrap());
    assert_eq!(db.get_note(&copy.id).unwrap().title, "Bank");
}

#[test]
fn is_note_locked_reports_missing_notes() {
    let db = db_with_pin();
    db.set_privacy_locked(true, &[]);
    assert_eq!(
        db.is_note_locked("missing").unwrap_err().code(),
        "not_found"
    );
}
