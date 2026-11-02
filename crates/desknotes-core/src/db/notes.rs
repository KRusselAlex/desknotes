//! Note repository. Every write touching more than one table runs in a transaction.

use rusqlite::{OptionalExtension, Row, params};
use uuid::Uuid;

use super::Database;
use crate::error::{CoreError, CoreResult};
use crate::geometry::enforce_min_size;
use crate::model::*;
use crate::now_ms;
use crate::validation::{
    derive_search_text, derive_snippet, derive_title, empty_doc, parse_content, validate_color,
    validate_private_label,
};

const NOTE_COLUMNS: &str = "n.id, n.title, n.content_json, n.color, n.created_at, n.updated_at,
     n.archived_at, n.deleted_at, w.x, w.y, w.width, w.height, w.visible, w.always_on_top,
     n.edit_locked, w.collapsed, n.private, n.private_label";

/// Offset applied to a duplicated note so it does not hide the original.
const DUPLICATE_OFFSET: f64 = 24.0;

fn note_from_row(row: &Row<'_>) -> rusqlite::Result<(Note, String)> {
    let content_json: String = row.get(2)?;
    Ok((
        Note {
            id: row.get(0)?,
            title: row.get(1)?,
            content: serde_json::Value::Null,
            color: row.get(3)?,
            created_at: row.get(4)?,
            updated_at: row.get(5)?,
            archived_at: row.get(6)?,
            deleted_at: row.get(7)?,
            edit_locked: row.get(14)?,
            private: row.get(16)?,
            private_label: row.get(17)?,
            locked: false,
            window: NoteWindow {
                x: row.get(8)?,
                y: row.get(9)?,
                width: row.get(10)?,
                height: row.get(11)?,
                visible: row.get(12)?,
                always_on_top: row.get(13)?,
                collapsed: row.get(15)?,
            },
        },
        content_json,
    ))
}

/// What a locked private note shows instead of its title (design D2): its
/// label, or the fallback when it has none. Never the derived title.
fn display_label(label: &str) -> &str {
    if label.is_empty() {
        PRIVATE_FALLBACK_LABEL
    } else {
        label
    }
}

/// The locked view of a private note: colour, label and window state only.
/// The stored content is never parsed, so not even an error can describe it.
fn redacted(mut note: Note) -> Note {
    note.content = empty_doc();
    note.title = display_label(&note.private_label).to_string();
    note.locked = true;
    note
}

/// Parse stored content. Stored content was validated on write, so failure
/// here means the file was edited or corrupted: surface it, never discard it.
fn finish(pair: (Note, String)) -> CoreResult<Note> {
    let (mut note, raw) = pair;
    note.content = serde_json::from_str(&raw).map_err(|e| {
        CoreError::Validation(format!(
            "stored content of note {} is unreadable: {e}",
            note.id
        ))
    })?;
    Ok(note)
}

impl Database {
    pub fn create_note(&self, color: Option<&str>) -> CoreResult<Note> {
        let color = match color {
            Some(c) => validate_color(c)?,
            None => DEFAULT_COLOR.to_string(),
        };
        let window = NoteWindow {
            x: None,
            y: None,
            width: DEFAULT_WIDTH,
            height: DEFAULT_HEIGHT,
            visible: true,
            always_on_top: false,
            collapsed: false,
        };
        self.insert_note(&empty_doc(), &color, &window, false, "")
    }

    fn insert_note(
        &self,
        content: &serde_json::Value,
        color: &str,
        window: &NoteWindow,
        private: bool,
        private_label: &str,
    ) -> CoreResult<Note> {
        let id = Uuid::new_v4().to_string();
        let now = now_ms();
        let tx = self.conn.unchecked_transaction()?;
        tx.execute(
            "INSERT INTO notes (id, title, content_json, search_text, color, created_at, updated_at,
                                private, private_label)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6, ?7, ?8)",
            params![
                id,
                derive_title(content),
                content.to_string(),
                derive_search_text(content),
                color,
                now,
                private,
                private_label
            ],
        )?;
        tx.execute(
            "INSERT INTO note_windows (note_id, x, y, width, height, visible, always_on_top, collapsed)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                id,
                window.x,
                window.y,
                window.width,
                window.height,
                window.visible,
                window.always_on_top,
                window.collapsed
            ],
        )?;
        tx.commit()?;
        self.get_note(&id)
    }

    /// A note, or its locked view while the privacy lock withholds it.
    pub fn get_note(&self, id: &str) -> CoreResult<Note> {
        let sql = format!(
            "SELECT {NOTE_COLUMNS} FROM notes n JOIN note_windows w ON w.note_id = n.id
             WHERE n.id = ?1"
        );
        let pair = self
            .conn
            .query_row(&sql, [id], note_from_row)
            .optional()?
            .ok_or_else(|| CoreError::NotFound(id.to_string()))?;
        if pair.0.private && self.withholds(id)? {
            return Ok(redacted(pair.0));
        }
        finish(pair)
    }

    /// True when the lock is in effect and the note with this id is not kept open.
    /// Only meaningful for private notes. `lock` is `self.lock_active()`.
    fn withheld(&self, lock: bool, private: bool, id: &str) -> bool {
        private && lock && !self.kept_open.borrow().contains(id)
    }

    /// Notes whose windows should be open: visible, not archived, not in trash.
    /// Returns the readable notes and the ids of notes whose stored content is
    /// unreadable, so one damaged note never stops the others from opening.
    pub fn notes_to_show(&self) -> CoreResult<(Vec<Note>, Vec<String>)> {
        let sql = format!(
            "SELECT {NOTE_COLUMNS} FROM notes n JOIN note_windows w ON w.note_id = n.id
             WHERE w.visible = 1 AND n.archived_at IS NULL AND n.deleted_at IS NULL
             ORDER BY n.created_at"
        );
        let lock = self.lock_active()?;
        let mut stmt = self.conn.prepare(&sql)?;
        let rows = stmt.query_map([], note_from_row)?;
        let (mut notes, mut unreadable) = (Vec::new(), Vec::new());
        for row in rows {
            let pair = row?;
            let id = pair.0.id.clone();
            if self.withheld(lock, pair.0.private, &id) {
                notes.push(redacted(pair.0));
                continue;
            }
            match finish(pair) {
                Ok(note) => notes.push(note),
                Err(_) => unreadable.push(id),
            }
        }
        Ok((notes, unreadable))
    }

    /// Notes for the manager list, newest first. `query` matches anywhere in
    /// the note text, case-insensitively; matching rows carry a snippet.
    /// While locked, a withheld private note is listed under its label and
    /// matches a query on that label only, never on its text (design §4.4).
    pub fn list_notes(
        &self,
        filter: NoteFilter,
        query: Option<&str>,
    ) -> CoreResult<Vec<NoteSummary>> {
        let condition = match filter {
            NoteFilter::Active => "n.archived_at IS NULL AND n.deleted_at IS NULL",
            NoteFilter::Archived => "n.archived_at IS NOT NULL AND n.deleted_at IS NULL",
            NoteFilter::Trash => "n.deleted_at IS NOT NULL",
        };
        let needle = query.map(|q| q.trim().to_lowercase()).unwrap_or_default();
        let lock = self.lock_active()?;
        // Private notes are all fetched while locked; which of them match is
        // decided below, once it is known whether each one is withheld.
        let sql = format!(
            "SELECT n.id, n.title, n.color, n.updated_at, n.archived_at, n.deleted_at, w.visible,
                    n.private, n.private_label,
                    CASE WHEN ?1 = '' THEN NULL ELSE n.content_json END,
                    ?1 <> '' AND instr(n.search_text, ?1) > 0
             FROM notes n JOIN note_windows w ON w.note_id = n.id
             WHERE {condition}
               AND (?1 = '' OR instr(n.search_text, ?1) > 0 OR (?2 AND n.private = 1))
             ORDER BY n.updated_at DESC"
        );
        let mut stmt = self.conn.prepare(&sql)?;
        let rows = stmt.query_map(params![needle, lock], |r| {
            let content: Option<String> = r.get(9)?;
            let text_hit: bool = r.get(10)?;
            Ok((
                NoteSummary {
                    id: r.get(0)?,
                    title: r.get(1)?,
                    color: r.get(2)?,
                    updated_at: r.get(3)?,
                    archived_at: r.get(4)?,
                    deleted_at: r.get(5)?,
                    visible: r.get(6)?,
                    private: r.get(7)?,
                    private_label: r.get(8)?,
                    locked: false,
                    snippet: None,
                },
                content,
                text_hit,
            ))
        })?;
        let mut out = Vec::new();
        for row in rows {
            let (mut summary, content, text_hit) = row?;
            if self.withheld(lock, summary.private, &summary.id) {
                let label = display_label(&summary.private_label).to_string();
                if !needle.is_empty() && !label.to_lowercase().contains(&needle) {
                    continue;
                }
                summary.title = label;
                summary.locked = true;
                out.push(summary);
                continue;
            }
            if !needle.is_empty() && !text_hit {
                continue;
            }
            if let Some(raw) = content {
                // A note whose stored JSON is unreadable is still listed, just without a snippet.
                if let Ok(doc) = serde_json::from_str::<serde_json::Value>(&raw) {
                    summary.snippet = derive_snippet(&doc, &needle);
                }
            }
            out.push(summary);
        }
        Ok(out)
    }

    /// Counts for the manager tabs.
    pub fn count_notes(&self) -> CoreResult<NoteCounts> {
        Ok(self.conn.query_row(
            "SELECT
                coalesce(sum(archived_at IS NULL AND deleted_at IS NULL), 0),
                coalesce(sum(archived_at IS NOT NULL AND deleted_at IS NULL), 0),
                coalesce(sum(deleted_at IS NOT NULL), 0)
             FROM notes",
            [],
            |r| {
                Ok(NoteCounts {
                    active: r.get(0)?,
                    archived: r.get(1)?,
                    trash: r.get(2)?,
                })
            },
        )?)
    }

    /// Validate and store new content. `raw` is the editor's JSON document.
    /// Refused while the note is edit-locked, or private and withheld by the lock.
    pub fn save_content(&self, id: &str, raw: &str) -> CoreResult<SaveResult> {
        self.refuse_if_note_locked(id)?;
        let doc = parse_content(raw)?;
        let title = derive_title(&doc);
        let now = now_ms();
        let changed = self.conn.execute(
            "UPDATE notes SET content_json = ?2, title = ?3, search_text = ?4, updated_at = ?5
             WHERE id = ?1 AND edit_locked = 0",
            params![id, doc.to_string(), title, derive_search_text(&doc), now],
        )?;
        if changed == 0 {
            if self.get_note(id)?.edit_locked {
                return Err(CoreError::NotAllowed(
                    "this note is locked for editing".into(),
                ));
            }
            return Err(CoreError::NotFound(id.to_string()));
        }
        Ok(SaveResult {
            title,
            updated_at: now,
        })
    }

    /// Lock or unlock a note against accidental edits.
    pub fn set_edit_locked(&self, id: &str, locked: bool) -> CoreResult<()> {
        let changed = self.conn.execute(
            "UPDATE notes SET edit_locked = ?2 WHERE id = ?1",
            params![id, locked],
        )?;
        self.expect_one(changed, id)
    }

    /// Mark a note private or not, with its neutral label. The label is stored
    /// validated; clearing `private` keeps the label for next time.
    ///
    /// While the lock is in effect, a private note cannot change at all, whether
    /// it is withheld or kept open at the last lock (design §4.2: label and
    /// "Make not private" need the PIN). A normal note made private while locked
    /// is kept open, so its open editor can keep saving until the shell releases
    /// it, like a note whose save failed at lock.
    pub fn set_private(&self, id: &str, private: bool, label: &str) -> CoreResult<()> {
        self.refuse_if_note_locked(id)?;
        let label = validate_private_label(label)?;
        let locked = self.lock_active()?;
        let newly_private_while_locked = if locked {
            let currently_private = self
                .conn
                .query_row("SELECT private FROM notes WHERE id = ?1", [id], |r| {
                    r.get::<_, bool>(0)
                })
                .optional()?;
            if currently_private == Some(true) {
                return Err(CoreError::NotAllowed(super::PRIVATE_LOCKED.into()));
            }
            // A missing note falls through to `not_found` below.
            private && currently_private.is_some()
        } else {
            false
        };
        let changed = self.conn.execute(
            "UPDATE notes SET private = ?2, private_label = ?3 WHERE id = ?1",
            params![id, private, label],
        )?;
        self.expect_one(changed, id)?;
        if newly_private_while_locked {
            self.kept_open.borrow_mut().insert(id.to_string());
        }
        Ok(())
    }

    pub fn set_color(&self, id: &str, color: &str) -> CoreResult<()> {
        let color = validate_color(color)?;
        let changed = self.conn.execute(
            "UPDATE notes SET color = ?2, updated_at = ?3 WHERE id = ?1",
            params![id, color, now_ms()],
        )?;
        self.expect_one(changed, id)
    }

    /// Copy a note. A copy of a private note is private, with the same label.
    /// Refused for a note the lock withholds.
    pub fn duplicate_note(&self, id: &str) -> CoreResult<Note> {
        self.refuse_if_note_locked(id)?;
        let original = self.get_note(id)?;
        let w = &original.window;
        let window = NoteWindow {
            x: w.x.map(|x| x + DUPLICATE_OFFSET),
            y: w.y.map(|y| y + DUPLICATE_OFFSET),
            visible: true,
            collapsed: false,
            ..w.clone()
        };
        self.insert_note(
            &original.content,
            &original.color,
            &window,
            original.private,
            &original.private_label,
        )
    }

    /// Archive hides the window; the note stays searchable under "Archived".
    pub fn set_archived(&self, id: &str, archived: bool) -> CoreResult<()> {
        let tx = self.conn.unchecked_transaction()?;
        let changed = tx.execute(
            "UPDATE notes SET archived_at = CASE WHEN ?2 THEN ?3 ELSE NULL END
             WHERE id = ?1 AND deleted_at IS NULL",
            params![id, archived, now_ms()],
        )?;
        if changed == 0 {
            self.get_note(id)?; // NotFound if it does not exist at all
            return Err(CoreError::NotAllowed(
                "restore the note from the trash first".into(),
            ));
        }
        tx.execute(
            "UPDATE note_windows SET visible = CASE WHEN ?2 THEN 0 ELSE 1 END WHERE note_id = ?1",
            params![id, archived],
        )?;
        tx.commit()?;
        Ok(())
    }

    /// Move to trash (recoverable). Hides the window.
    pub fn trash_note(&self, id: &str) -> CoreResult<()> {
        let tx = self.conn.unchecked_transaction()?;
        let changed = tx.execute(
            "UPDATE notes SET deleted_at = ?2 WHERE id = ?1 AND deleted_at IS NULL",
            params![id, now_ms()],
        )?;
        self.expect_one(changed, id)?;
        tx.execute(
            "UPDATE note_windows SET visible = 0 WHERE note_id = ?1",
            [id],
        )?;
        tx.commit()?;
        Ok(())
    }

    /// Bring a note back from the trash. It returns to where it was (active
    /// or archived) and shows again if it was active.
    pub fn restore_note(&self, id: &str) -> CoreResult<()> {
        let tx = self.conn.unchecked_transaction()?;
        let changed = tx.execute(
            "UPDATE notes SET deleted_at = NULL WHERE id = ?1 AND deleted_at IS NOT NULL",
            [id],
        )?;
        self.expect_one(changed, id)?;
        tx.execute(
            "UPDATE note_windows SET visible = 1 WHERE note_id = ?1
             AND (SELECT archived_at FROM notes WHERE id = ?1) IS NULL",
            [id],
        )?;
        tx.commit()?;
        Ok(())
    }

    /// Permanently delete. Only allowed for notes already in the trash, so a
    /// single mistaken call can never destroy an active note, and never for a
    /// note the lock withholds.
    pub fn purge_note(&self, id: &str) -> CoreResult<()> {
        self.refuse_if_note_locked(id)?;
        let changed = self.conn.execute(
            "DELETE FROM notes WHERE id = ?1 AND deleted_at IS NOT NULL",
            [id],
        )?;
        if changed == 0 {
            self.get_note(id)?; // NotFound if it does not exist at all
            return Err(CoreError::NotAllowed(
                "only notes in the trash can be deleted permanently".into(),
            ));
        }
        self.release_kept_open(id);
        Ok(())
    }

    /// Store a window's size, and its position when the platform reports a
    /// real one (`None` keeps the saved position, e.g. on native Wayland).
    pub fn set_window_geometry(
        &self,
        id: &str,
        position: Option<(f64, f64)>,
        width: f64,
        height: f64,
    ) -> CoreResult<()> {
        if position.is_some_and(|(x, y)| !(x.is_finite() && y.is_finite())) {
            return Err(CoreError::Validation(
                "window position must be finite".into(),
            ));
        }
        let (width, height) = enforce_min_size(width, height);
        let (x, y) = position.unzip();
        let changed = self.conn.execute(
            // While collapsed, the window is only a header strip: keep the
            // expanded height so the note reopens at its real size.
            "UPDATE note_windows SET x = COALESCE(?2, x), y = COALESCE(?3, y), width = ?4,
                    height = CASE WHEN collapsed = 1 THEN height ELSE ?5 END
             WHERE note_id = ?1",
            params![id, x, y, width, height],
        )?;
        self.expect_one(changed, id)
    }

    pub fn set_always_on_top(&self, id: &str, on: bool) -> CoreResult<()> {
        let changed = self.conn.execute(
            "UPDATE note_windows SET always_on_top = ?2 WHERE note_id = ?1",
            params![id, on],
        )?;
        self.expect_one(changed, id)
    }

    pub fn set_collapsed(&self, id: &str, collapsed: bool) -> CoreResult<()> {
        let changed = self.conn.execute(
            "UPDATE note_windows SET collapsed = ?2 WHERE note_id = ?1",
            params![id, collapsed],
        )?;
        self.expect_one(changed, id)
    }

    pub fn set_visible(&self, id: &str, visible: bool) -> CoreResult<()> {
        let changed = self.conn.execute(
            "UPDATE note_windows SET visible = ?2 WHERE note_id = ?1",
            params![id, visible],
        )?;
        self.expect_one(changed, id)
    }

    fn expect_one(&self, changed: usize, id: &str) -> CoreResult<()> {
        if changed == 1 {
            Ok(())
        } else {
            Err(CoreError::NotFound(id.to_string()))
        }
    }
}

#[cfg(test)]
mod tests {
    use crate::{Database, NoteFilter};

    const FIXTURE: &str = include_str!("../../../../tests/fixtures/rich-doc.json");

    fn db() -> Database {
        Database::open_in_memory().unwrap()
    }

    fn doc(text: &str) -> String {
        serde_json::json!({"type":"doc","content":[{"type":"paragraph","content":[
            {"type":"text","text":text}]}]})
        .to_string()
    }

    #[test]
    fn create_then_get() {
        let db = db();
        let note = db.create_note(None).unwrap();
        assert_eq!(note.color, crate::DEFAULT_COLOR);
        assert!(note.window.visible);
        assert_eq!(note.window.x, None);
        assert_eq!(db.get_note(&note.id).unwrap(), note);
        assert_eq!(db.get_note("missing").unwrap_err().code(), "not_found");
    }

    #[test]
    fn rich_content_round_trips_exactly() {
        let db = db();
        let id = db.create_note(None).unwrap().id;
        let saved = db.save_content(&id, FIXTURE).unwrap();
        assert_eq!(saved.title, "Groceries for Saturday");
        let expected: serde_json::Value = serde_json::from_str(FIXTURE).unwrap();
        assert_eq!(db.get_note(&id).unwrap().content, expected);
    }

    #[test]
    fn invalid_content_is_rejected_and_old_content_kept() {
        let db = db();
        let id = db.create_note(None).unwrap().id;
        db.save_content(&id, &doc("keep me")).unwrap();
        let bad = r#"{"type":"doc","content":[{"type":"script"}]}"#;
        assert_eq!(db.save_content(&id, bad).unwrap_err().code(), "validation");
        assert_eq!(db.get_note(&id).unwrap().title, "keep me");
    }

    #[test]
    fn saving_unknown_note_fails() {
        assert_eq!(
            db().save_content("nope", &doc("x")).unwrap_err().code(),
            "not_found"
        );
    }

    #[test]
    fn search_is_case_insensitive_and_unicode_aware() {
        let db = db();
        let a = db.create_note(None).unwrap().id;
        let b = db.create_note(None).unwrap().id;
        db.save_content(&a, &doc("Rendez-vous ÉCOLE lundi"))
            .unwrap();
        db.save_content(&b, &doc("Buy 50% more_coffee")).unwrap();
        let hits = |q: &str| -> Vec<String> {
            db.list_notes(NoteFilter::Active, Some(q))
                .unwrap()
                .into_iter()
                .map(|n| n.id)
                .collect()
        };
        assert_eq!(hits("école"), vec![a.clone()]);
        assert_eq!(hits("50%"), vec![b.clone()]);
        assert_eq!(hits("_c"), vec![b.clone()]);
        assert_eq!(hits("  ").len(), 2);
        assert!(hits("absent").is_empty());
    }

    #[test]
    fn search_rows_carry_a_snippet_and_counts_follow_tabs() {
        let db = db();
        let a = db.create_note(None).unwrap().id;
        let b = db.create_note(None).unwrap().id;
        let c = db.create_note(None).unwrap().id;
        db.save_content(&a, &doc("Pick up the Bike before 5"))
            .unwrap();
        db.set_archived(&b, true).unwrap();
        db.trash_note(&c).unwrap();

        let hits = db.list_notes(NoteFilter::Active, Some("bike")).unwrap();
        assert_eq!(
            hits[0].snippet.as_deref(),
            Some("Pick up the Bike before 5")
        );
        assert!(
            db.list_notes(NoteFilter::Active, None).unwrap()[0]
                .snippet
                .is_none()
        );

        let counts = db.count_notes().unwrap();
        assert_eq!((counts.active, counts.archived, counts.trash), (1, 1, 1));
    }

    #[test]
    fn archive_hides_and_moves_between_lists() {
        let db = db();
        let id = db.create_note(None).unwrap().id;
        db.set_archived(&id, true).unwrap();
        assert!(db.list_notes(NoteFilter::Active, None).unwrap().is_empty());
        assert_eq!(db.list_notes(NoteFilter::Archived, None).unwrap().len(), 1);
        assert!(db.notes_to_show().unwrap().0.is_empty());
        db.set_archived(&id, false).unwrap();
        assert_eq!(db.notes_to_show().unwrap().0.len(), 1);
    }

    #[test]
    fn trash_restore_and_purge() {
        let db = db();
        let id = db.create_note(None).unwrap().id;
        assert_eq!(db.purge_note(&id).unwrap_err().code(), "not_allowed");

        db.trash_note(&id).unwrap();
        assert!(db.notes_to_show().unwrap().0.is_empty());
        assert_eq!(db.list_notes(NoteFilter::Trash, None).unwrap().len(), 1);
        assert!(db.trash_note(&id).is_err(), "already in trash");

        db.restore_note(&id).unwrap();
        assert_eq!(db.notes_to_show().unwrap().0.len(), 1);

        db.trash_note(&id).unwrap();
        db.purge_note(&id).unwrap();
        assert_eq!(db.get_note(&id).unwrap_err().code(), "not_found");
        let windows: i64 = db
            .conn
            .query_row("SELECT count(*) FROM note_windows", [], |r| r.get(0))
            .unwrap();
        assert_eq!(windows, 0, "window row removed by cascade");
    }

    #[test]
    fn restoring_an_archived_note_keeps_it_archived_and_hidden() {
        let db = db();
        let id = db.create_note(None).unwrap().id;
        db.set_archived(&id, true).unwrap();
        db.trash_note(&id).unwrap();
        db.restore_note(&id).unwrap();
        assert_eq!(db.list_notes(NoteFilter::Archived, None).unwrap().len(), 1);
        assert!(!db.get_note(&id).unwrap().window.visible);
    }

    #[test]
    fn duplicate_copies_content_color_and_offsets_window() {
        let db = db();
        let id = db.create_note(Some("#c8f7c5")).unwrap().id;
        db.save_content(&id, FIXTURE).unwrap();
        db.set_window_geometry(&id, Some((100.0, 200.0)), 400.0, 300.0)
            .unwrap();
        let copy = db.duplicate_note(&id).unwrap();
        let original = db.get_note(&id).unwrap();
        assert_ne!(copy.id, id);
        assert_eq!(copy.content, original.content);
        assert_eq!(copy.color, "#c8f7c5");
        assert_eq!((copy.window.x, copy.window.y), (Some(124.0), Some(224.0)));
        assert_eq!((copy.window.width, copy.window.height), (400.0, 300.0));
    }

    #[test]
    fn geometry_is_stored_and_min_size_enforced() {
        let db = db();
        let id = db.create_note(None).unwrap().id;
        db.set_window_geometry(&id, Some((-50.0, 10.5)), 20.0, 20.0)
            .unwrap();
        let w = db.get_note(&id).unwrap().window;
        assert_eq!((w.x, w.y), (Some(-50.0), Some(10.5)));
        assert_eq!((w.width, w.height), (crate::MIN_WIDTH, crate::MIN_HEIGHT));
        assert!(
            db.set_window_geometry(&id, Some((f64::NAN, 0.0)), 300.0, 300.0)
                .is_err()
        );

        // A size-only update keeps the saved position.
        db.set_window_geometry(&id, None, 500.0, 400.0).unwrap();
        let w = db.get_note(&id).unwrap().window;
        assert_eq!(
            (w.x, w.y, w.width, w.height),
            (Some(-50.0), Some(10.5), 500.0, 400.0)
        );
    }

    #[test]
    fn edit_lock_refuses_content_changes_until_unlocked() {
        let db = db();
        let id = db.create_note(None).unwrap().id;
        db.save_content(&id, &doc("original")).unwrap();
        assert!(!db.get_note(&id).unwrap().edit_locked);

        db.set_edit_locked(&id, true).unwrap();
        assert!(db.get_note(&id).unwrap().edit_locked);
        assert_eq!(
            db.save_content(&id, &doc("oops")).unwrap_err().code(),
            "not_allowed"
        );
        assert_eq!(db.get_note(&id).unwrap().title, "original");
        // Deliberate actions still work on a locked note.
        db.set_color(&id, "#cfe8ff").unwrap();

        db.set_edit_locked(&id, false).unwrap();
        db.save_content(&id, &doc("changed")).unwrap();
        assert_eq!(db.get_note(&id).unwrap().title, "changed");
        assert_eq!(
            db.set_edit_locked("missing", true).unwrap_err().code(),
            "not_found"
        );
    }

    #[test]
    fn always_on_top_and_collapse_are_stored() {
        let db = db();
        let id = db.create_note(None).unwrap().id;
        db.set_always_on_top(&id, true).unwrap();
        assert!(db.get_note(&id).unwrap().window.always_on_top);
        db.set_always_on_top(&id, false).unwrap();
        assert!(!db.get_note(&id).unwrap().window.always_on_top);
        assert_eq!(
            db.set_collapsed("nope", true).unwrap_err().code(),
            "not_found"
        );
    }

    #[test]
    fn collapsing_keeps_the_expanded_height() {
        let db = db();
        let id = db.create_note(None).unwrap().id;
        db.set_window_geometry(&id, Some((10.0, 20.0)), 300.0, 280.0)
            .unwrap();
        db.set_collapsed(&id, true).unwrap();
        // The window is now a 32 px strip; it is moved and made wider.
        db.set_window_geometry(&id, Some((50.0, 60.0)), 320.0, 32.0)
            .unwrap();
        let w = db.get_note(&id).unwrap().window;
        assert!(w.collapsed);
        assert_eq!(
            (w.x, w.y, w.width, w.height),
            (Some(50.0), Some(60.0), 320.0, 280.0)
        );
        db.set_collapsed(&id, false).unwrap();
        db.set_window_geometry(&id, None, 320.0, 400.0).unwrap();
        assert_eq!(db.get_note(&id).unwrap().window.height, 400.0);
    }

    #[test]
    fn color_and_visibility() {
        let db = db();
        let id = db.create_note(None).unwrap().id;
        db.set_color(&id, "#FFD6E0").unwrap();
        assert_eq!(db.get_note(&id).unwrap().color, "#ffd6e0");
        assert!(db.set_color(&id, "pink").is_err());
        db.set_visible(&id, false).unwrap();
        assert!(db.notes_to_show().unwrap().0.is_empty());
    }

    #[test]
    fn notes_in_the_trash_cannot_be_archived_or_unarchived() {
        let db = db();
        let id = db.create_note(None).unwrap().id;
        db.set_archived(&id, true).unwrap();
        db.trash_note(&id).unwrap();
        assert_eq!(
            db.set_archived(&id, false).unwrap_err().code(),
            "not_allowed"
        );
        assert!(!db.get_note(&id).unwrap().window.visible);
        assert_eq!(
            db.set_archived("nope", true).unwrap_err().code(),
            "not_found"
        );
    }

    #[test]
    fn one_unreadable_note_does_not_stop_the_others_from_opening() {
        let db = db();
        let good = db.create_note(None).unwrap().id;
        let bad = db.create_note(None).unwrap().id;
        db.conn
            .execute(
                "UPDATE notes SET content_json = '{oops' WHERE id = ?1",
                [&bad],
            )
            .unwrap();
        let (notes, unreadable) = db.notes_to_show().unwrap();
        assert_eq!(notes.len(), 1);
        assert_eq!(notes[0].id, good);
        assert_eq!(unreadable, vec![bad]);
    }

    #[test]
    fn corrupted_stored_content_is_reported_not_dropped() {
        let db = db();
        let id = db.create_note(None).unwrap().id;
        db.conn
            .execute(
                "UPDATE notes SET content_json = '{oops' WHERE id = ?1",
                [&id],
            )
            .unwrap();
        assert_eq!(db.get_note(&id).unwrap_err().code(), "validation");
        let raw: String = db
            .conn
            .query_row("SELECT content_json FROM notes WHERE id = ?1", [&id], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(raw, "{oops");
    }

    #[test]
    fn set_private_round_trips_with_label() {
        let db = db();
        let id = db.create_note(None).unwrap().id;
        let note = db.get_note(&id).unwrap();
        assert!(!note.private);
        assert_eq!(note.private_label, "");

        db.set_private(&id, true, "  Bank ").unwrap();
        let note = db.get_note(&id).unwrap();
        assert!(note.private);
        assert_eq!(note.private_label, "Bank");
        let summary = &db.list_notes(NoteFilter::Active, None).unwrap()[0];
        assert!(summary.private);
        assert_eq!(summary.private_label, "Bank");
        assert!(!summary.locked);

        // Clearing the flag keeps the label.
        db.set_private(&id, false, "Bank").unwrap();
        let note = db.get_note(&id).unwrap();
        assert!(!note.private);
        assert_eq!(note.private_label, "Bank");

        assert_eq!(
            db.set_private(&id, true, &"x".repeat(41))
                .unwrap_err()
                .code(),
            "validation"
        );
        assert_eq!(
            db.set_private("missing", true, "").unwrap_err().code(),
            "not_found"
        );
    }
}
