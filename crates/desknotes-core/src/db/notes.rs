//! Note repository. Every write touching more than one table runs in a transaction.

use rusqlite::{OptionalExtension, Row, params};
use uuid::Uuid;

use super::Database;
use super::images::sync_note_images_in;
use crate::error::{CoreError, CoreResult};
use crate::geometry::enforce_min_size;
use crate::model::*;
use crate::now_ms;
use crate::validation::{
    derive_search_text, derive_snippet, derive_title, empty_doc, parse_appearance, parse_content,
    validate_appearance, validate_color, validate_private_label,
};

const NOTE_COLUMNS: &str = "n.id, n.title, n.content_json, n.color, n.created_at, n.updated_at,
     n.archived_at, n.deleted_at, w.x, w.y, w.width, w.height, w.visible, w.always_on_top,
     n.edit_locked, w.collapsed, n.private, n.private_label, n.appearance, n.completed_at";

/// Offset applied to a duplicated note so it does not hide the original.
const DUPLICATE_OFFSET: f64 = 24.0;

/// A note's stored appearance, or the defaults (logged) when it is damaged.
fn stored_appearance(id: &str, raw: &str) -> Appearance {
    parse_appearance(raw).unwrap_or_else(|e| {
        eprintln!("DeskNotes: note {id} has a damaged appearance, using the defaults: {e}");
        Appearance::default()
    })
}

fn note_from_row(row: &Row<'_>) -> rusqlite::Result<(Note, String)> {
    let id: String = row.get(0)?;
    let content_json: String = row.get(2)?;
    // Styling is cosmetic: a damaged value falls back to the defaults rather
    // than stopping the note from opening (and is logged, since a backup then
    // holds the defaults too).
    let appearance = stored_appearance(&id, &row.get::<_, String>(18)?);
    Ok((
        Note {
            id,
            title: row.get(1)?,
            content: serde_json::Value::Null,
            color: row.get(3)?,
            created_at: row.get(4)?,
            updated_at: row.get(5)?,
            archived_at: row.get(6)?,
            deleted_at: row.get(7)?,
            completed_at: row.get(19)?,
            edit_locked: row.get(14)?,
            private: row.get(16)?,
            private_label: row.get(17)?,
            locked: false,
            appearance,
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

/// The compact JSON stored in `notes.appearance`.
pub(super) fn appearance_json(appearance: &Appearance) -> CoreResult<String> {
    serde_json::to_string(appearance)
        .map_err(|e| CoreError::Validation(format!("appearance cannot be stored: {e}")))
}

/// What a locked private note shows instead of its title (design D2): its
/// label, or the fallback when it has none. Never the derived title.
pub(super) fn display_label(label: &str) -> &str {
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
        self.insert_note(
            &empty_doc(),
            &color,
            &window,
            false,
            "",
            &Appearance::default(),
        )
    }

    fn insert_note(
        &self,
        content: &serde_json::Value,
        color: &str,
        window: &NoteWindow,
        private: bool,
        private_label: &str,
        appearance: &Appearance,
    ) -> CoreResult<Note> {
        let tx = self.conn.unchecked_transaction()?;
        let id = Self::insert_note_in(
            &tx,
            content,
            color,
            window,
            private,
            private_label,
            appearance,
        )?;
        tx.commit()?;
        self.get_note(&id)
    }

    /// The two inserts of a new note, inside a transaction the caller owns, so a
    /// caller can add more writes to the same transaction. Returns the new id.
    pub(super) fn insert_note_in(
        tx: &rusqlite::Transaction<'_>,
        content: &serde_json::Value,
        color: &str,
        window: &NoteWindow,
        private: bool,
        private_label: &str,
        appearance: &Appearance,
    ) -> CoreResult<String> {
        let id = Uuid::new_v4().to_string();
        let now = now_ms();
        tx.execute(
            "INSERT INTO notes (id, title, content_json, search_text, color, created_at, updated_at,
                                private, private_label, appearance)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6, ?7, ?8, ?9)",
            params![
                id,
                derive_title(content),
                content.to_string(),
                derive_search_text(content),
                color,
                now,
                private,
                private_label,
                appearance_json(appearance)?
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
        sync_note_images_in(tx, &id, content)?;
        Ok(id)
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

    /// The one "withheld" rule: a private note is withheld when the lock is in effect
    /// and it is not kept open. `lock` is `self.lock_active()`.
    pub(super) fn withheld(&self, lock: bool, private: bool, id: &str) -> bool {
        private && lock && !self.kept_open.borrow().contains(id)
    }

    /// Notes whose windows should be open: visible, not archived, not done, not in trash.
    /// Returns the readable notes and the ids of notes whose stored content is
    /// unreadable, so one damaged note never stops the others from opening.
    pub fn notes_to_show(&self) -> CoreResult<(Vec<Note>, Vec<String>)> {
        let sql = format!(
            "SELECT {NOTE_COLUMNS} FROM notes n JOIN note_windows w ON w.note_id = n.id
             WHERE w.visible = 1 AND n.archived_at IS NULL AND n.deleted_at IS NULL
               AND n.completed_at IS NULL
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
            // A note is in exactly one list: Trash, else Archived, else Completed, else Active.
            NoteFilter::Active => {
                "n.archived_at IS NULL AND n.deleted_at IS NULL AND n.completed_at IS NULL"
            }
            NoteFilter::Completed => {
                "n.completed_at IS NOT NULL AND n.archived_at IS NULL AND n.deleted_at IS NULL"
            }
            NoteFilter::Archived => "n.archived_at IS NOT NULL AND n.deleted_at IS NULL",
            NoteFilter::Trash => "n.deleted_at IS NOT NULL",
        };
        // Completed is newest-done first; the other lists follow the last edit.
        let order = match filter {
            NoteFilter::Completed => "n.completed_at DESC, n.updated_at DESC",
            _ => "n.updated_at DESC",
        };
        let needle = query.map(|q| q.trim().to_lowercase()).unwrap_or_default();
        let lock = self.lock_active()?;
        // Private notes are all fetched while locked; which of them match is
        // decided below, once it is known whether each one is withheld.
        let sql = format!(
            "SELECT n.id, n.title, n.color, n.updated_at, n.archived_at, n.deleted_at, w.visible,
                    n.private, n.private_label,
                    CASE WHEN ?1 = '' THEN NULL ELSE n.content_json END,
                    ?1 <> '' AND instr(n.search_text, ?1) > 0, n.completed_at
             FROM notes n JOIN note_windows w ON w.note_id = n.id
             WHERE {condition}
               AND (?1 = '' OR instr(n.search_text, ?1) > 0 OR (?2 AND n.private = 1))
             ORDER BY {order}"
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
                    completed_at: r.get(11)?,
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
                coalesce(sum(archived_at IS NULL AND deleted_at IS NULL AND completed_at IS NULL), 0),
                coalesce(sum(completed_at IS NOT NULL AND archived_at IS NULL AND deleted_at IS NULL), 0),
                coalesce(sum(archived_at IS NOT NULL AND deleted_at IS NULL), 0),
                coalesce(sum(deleted_at IS NOT NULL), 0)
             FROM notes",
            [],
            |r| {
                Ok(NoteCounts {
                    active: r.get(0)?,
                    completed: r.get(1)?,
                    archived: r.get(2)?,
                    trash: r.get(3)?,
                })
            },
        )?)
    }

    /// Validate and store new content. `raw` is the editor's JSON document.
    /// Refused while the note is edit-locked, or private and withheld by the lock.
    pub fn save_content(&self, id: &str, raw: &str) -> CoreResult<SaveResult> {
        let tx = self.conn.unchecked_transaction()?;
        let saved = self.save_content_in(&tx, id, raw)?;
        tx.commit()?;
        Ok(saved)
    }

    /// [`Database::save_content`] inside a transaction the caller owns and commits,
    /// so the content and the images it uses are stored together or not at all.
    pub(super) fn save_content_in(
        &self,
        tx: &rusqlite::Transaction<'_>,
        id: &str,
        raw: &str,
    ) -> CoreResult<SaveResult> {
        self.refuse_if_note_locked(id)?;
        let doc = parse_content(raw)?;
        let title = derive_title(&doc);
        let now = now_ms();
        let changed = tx.execute(
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
        sync_note_images_in(tx, id, &doc)?;
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
                return Err(CoreError::PrivateLocked);
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

    /// Style a note's text and window. Not an edit, so `updated_at` stays, and
    /// allowed while the note is locked: styling reveals nothing about the text.
    pub fn set_appearance(&self, id: &str, appearance: &Appearance) -> CoreResult<()> {
        let appearance = validate_appearance(appearance.clone())?;
        let changed = self.conn.execute(
            "UPDATE notes SET appearance = ?2 WHERE id = ?1",
            params![id, appearance_json(&appearance)?],
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
            &original.appearance,
        )
    }

    /// Mark a note done, or reopen it. Only `completed_at` changes: the text, colour,
    /// styling, window, reminder and `updated_at` are never touched. Marking an
    /// already-done note done keeps its original date. Reopening also marks the window
    /// visible (unless the note is archived). Refused for a note in the trash,
    /// like archiving. The shell closes and opens the window.
    ///
    /// Returns whether the done state changed. Reopening a note that is not done changes
    /// nothing, the window flag included: a stale Reopen click must not show a hidden note.
    pub fn set_completed(&self, id: &str, done: bool, now_ms: i64) -> CoreResult<bool> {
        let tx = self.conn.unchecked_transaction()?;
        let was_done: Option<bool> = tx
            .query_row(
                "SELECT completed_at IS NOT NULL FROM notes WHERE id = ?1 AND deleted_at IS NULL",
                [id],
                |r| r.get(0),
            )
            .optional()?;
        let Some(was_done) = was_done else {
            self.get_note(id)?; // NotFound if it does not exist at all
            return Err(CoreError::NotAllowed(
                "restore the note from the trash first".into(),
            ));
        };
        if was_done == done {
            return Ok(false);
        }
        tx.execute(
            "UPDATE notes SET completed_at = CASE WHEN ?2 THEN ?3 ELSE NULL END WHERE id = ?1",
            params![id, done, now_ms],
        )?;
        if !done {
            // A reopened note is a visible one again, as after unarchiving: a hide-all that
            // ran while its "Marked done" strip ended may have cleared the flag. A note that
            // is also archived stays hidden (it is listed as Archived).
            tx.execute(
                "UPDATE note_windows SET visible = 1
                 WHERE note_id = ?1
                   AND (SELECT archived_at FROM notes WHERE id = ?1) IS NULL",
                [id],
            )?;
        }
        tx.commit()?;
        Ok(true)
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

    /// Set a note's (expanded) size without touching its position, also while
    /// it is collapsed. `set_window_geometry` keeps a collapsed note's height,
    /// because there the window is only the header strip.
    pub fn set_window_size(&self, id: &str, width: f64, height: f64) -> CoreResult<()> {
        let (width, height) = enforce_min_size(width, height);
        let changed = self.conn.execute(
            "UPDATE note_windows SET width = ?2, height = ?3 WHERE note_id = ?1",
            params![id, width, height],
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
    use rusqlite::Connection;

    use crate::db::migrations;
    use crate::db::privacy::PIN_HASH;
    use crate::{Appearance, Database, NoteFilter, TextDirection};

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
    fn a_label_saved_before_the_hidden_character_rule_still_lets_the_note_change() {
        // "Make not private" and Rename send the stored label back (DES-30 review).
        let db = Database::open_in_memory().unwrap();
        let id = db.create_note(None).unwrap().id;
        db.conn
            .execute(
                "UPDATE notes SET private = 1, private_label = ?2 WHERE id = ?1",
                rusqlite::params![id, "Ba\u{200B}nk"],
            )
            .unwrap();
        db.set_private(&id, false, "Ba\u{200B}nk").unwrap();
        let note = db.get_note(&id).unwrap();
        assert!(!note.private);
        assert_eq!(note.private_label, "Bank");
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

    fn reminder_rule() -> crate::reminders::ReminderRule {
        crate::reminders::validate_rule("2026-01-01", "09:00", "daily").unwrap()
    }

    #[test]
    fn purge_removes_the_notes_reminder() {
        let db = db();
        let id = db.create_note(None).unwrap().id;
        let other = db.create_note(None).unwrap().id;
        let now = chrono::Utc::now();
        for n in [&id, &other] {
            db.set_reminder(n, reminder_rule(), now, &chrono::Utc)
                .unwrap();
        }
        db.trash_note(&id).unwrap();
        assert!(
            db.reminder(&id).unwrap().is_some(),
            "kept while in the trash"
        );
        db.purge_note(&id).unwrap();
        let rows: i64 = db
            .conn
            .query_row(
                "SELECT count(*) FROM reminders WHERE note_id = ?1",
                [&id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(rows, 0, "reminder row removed by cascade");
        assert!(
            db.reminder(&other).unwrap().is_some(),
            "other notes keep theirs"
        );
    }

    #[test]
    fn duplicate_does_not_copy_the_reminder() {
        let db = db();
        let id = db.create_note(None).unwrap().id;
        db.set_reminder(&id, reminder_rule(), chrono::Utc::now(), &chrono::Utc)
            .unwrap();
        let copy = db.duplicate_note(&id).unwrap();
        assert_eq!(db.reminder(&copy.id).unwrap(), None);
        assert!(db.reminder(&id).unwrap().is_some(), "the original keeps it");
    }

    #[test]
    fn migration_6_adds_reminders_and_keeps_every_note() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("desknotes.db");
        let backups = dir.path().join("backups");
        let content = r#"{"type":"doc","content":[{"type":"paragraph"}]}"#;
        {
            let mut conn = Connection::open(&path).unwrap();
            migrations::apply_until(&mut conn, 0, 5).unwrap();
            for (id, title, trashed) in [
                ("2f1c8f0e-6a8b-4c51-9d4e-2b8f5f1a9c3d", "v5 note", "NULL"),
                ("3a2d9e1f-7b9c-4d62-8e5f-3c9a6b2b0d4e", "v5 trashed", "9"),
            ] {
                conn.execute_batch(&format!(
                    "INSERT INTO notes (id, title, content_json, color, created_at, updated_at, deleted_at)
                     VALUES ('{id}', '{title}', '{content}', '#fff4a3', 1, 7, {trashed});
                     INSERT INTO note_windows (note_id, width, height) VALUES ('{id}', 300, 280);"
                ))
                .unwrap();
            }
        }

        let db = Database::open(&path, &backups).unwrap();
        assert_eq!(db.schema_version().unwrap(), crate::db::LATEST_VERSION);
        assert_eq!(db.count_all_notes().unwrap(), 2);
        let note = db.get_note("2f1c8f0e-6a8b-4c51-9d4e-2b8f5f1a9c3d").unwrap();
        assert_eq!((note.title.as_str(), note.updated_at), ("v5 note", 7));
        assert_eq!(db.list_notes(NoteFilter::Trash, None).unwrap().len(), 1);
        assert_eq!(
            db.reminder("2f1c8f0e-6a8b-4c51-9d4e-2b8f5f1a9c3d").unwrap(),
            None
        );
        // The existing safety copy was taken before the upgrade.
        let copies: Vec<_> = std::fs::read_dir(&backups).unwrap().collect();
        assert_eq!(copies.len(), 1);
        let name = copies[0].as_ref().unwrap().file_name();
        assert!(name.to_string_lossy().starts_with("pre-migration-v5-"));
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

    fn counts(db: &Database) -> (i64, i64, i64, i64) {
        let c = db.count_notes().unwrap();
        (c.active, c.completed, c.archived, c.trash)
    }

    #[test]
    fn completing_touches_only_completed_at() {
        let db = db();
        let id = db.create_note(Some("#c8f7c5")).unwrap().id;
        db.save_content(&id, FIXTURE).unwrap();
        db.set_appearance(&id, &Appearance::default()).unwrap();
        db.set_window_geometry(&id, Some((40.0, 50.0)), 360.0, 300.0)
            .unwrap();
        db.set_always_on_top(&id, true).unwrap();
        db.set_edit_locked(&id, true).unwrap();
        let rule = crate::reminders::validate_rule("2030-01-01", "09:00", "daily").unwrap();
        db.set_reminder(&id, rule, chrono::Utc::now(), &chrono::Utc)
            .unwrap();
        let before = db.get_note(&id).unwrap();
        let reminder = db.reminder(&id).unwrap();
        assert_eq!(before.completed_at, None);

        db.set_completed(&id, true, 5_000).unwrap();
        let done = db.get_note(&id).unwrap();
        assert_eq!(done.completed_at, Some(5_000));
        assert_eq!(
            crate::Note {
                completed_at: None,
                ..done
            },
            before,
            "content, colour, appearance, window, lock and updated_at are untouched"
        );
        assert_eq!(db.reminder(&id).unwrap(), reminder);

        // Marking an already-done note done again keeps the original date.
        db.set_completed(&id, true, 9_000).unwrap();
        assert_eq!(db.get_note(&id).unwrap().completed_at, Some(5_000));

        db.set_completed(&id, false, 9_500).unwrap();
        assert_eq!(db.get_note(&id).unwrap(), before, "reopen restores it all");
        assert_eq!(db.reminder(&id).unwrap(), reminder);
    }

    #[test]
    fn reopening_makes_the_window_visible_again() {
        let db = db();
        let id = db.create_note(None).unwrap().id;
        db.save_content(&id, FIXTURE).unwrap();
        db.set_completed(&id, true, 5_000).unwrap();
        // Hide-all ran while the done strip was ending and hid the note.
        db.set_visible(&id, false).unwrap();
        let hidden = db.get_note(&id).unwrap();

        db.set_completed(&id, false, 6_000).unwrap();
        let reopened = db.get_note(&id).unwrap();
        assert!(
            reopened.window.visible,
            "the reopened note opens at restart"
        );
        assert_eq!(
            crate::Note {
                window: crate::NoteWindow {
                    visible: false,
                    ..reopened.window.clone()
                },
                ..reopened
            },
            crate::Note {
                completed_at: None,
                ..hidden
            },
            "only the visible flag differs from before"
        );
    }

    #[test]
    fn reopening_a_note_that_is_not_done_changes_nothing() {
        let db = db();
        let id = db.create_note(None).unwrap().id;
        // A hidden active note, then a stale Reopen click from a list drawn before.
        db.set_visible(&id, false).unwrap();
        let before = db.get_note(&id).unwrap();
        assert!(
            !db.set_completed(&id, false, 6_000).unwrap(),
            "reports no change"
        );
        assert_eq!(db.get_note(&id).unwrap(), before, "it stays hidden");
    }

    #[test]
    fn set_completed_reports_whether_the_done_state_changed() {
        let db = db();
        let id = db.create_note(None).unwrap().id;
        assert!(db.set_completed(&id, true, 5_000).unwrap());
        assert!(!db.set_completed(&id, true, 9_000).unwrap(), "already done");
        assert!(db.set_completed(&id, false, 9_500).unwrap());
    }

    #[test]
    fn reopening_a_note_that_is_also_archived_keeps_it_hidden() {
        let db = db();
        let id = db.create_note(None).unwrap().id;
        db.set_completed(&id, true, 5_000).unwrap();
        db.set_archived(&id, true).unwrap();
        db.set_completed(&id, false, 6_000).unwrap();
        assert!(!db.get_note(&id).unwrap().window.visible);
        assert_eq!(db.list_notes(NoteFilter::Archived, None).unwrap().len(), 1);
    }

    #[test]
    fn the_completed_list_is_newest_done_first() {
        let db = db();
        let old = db.create_note(None).unwrap().id;
        let new = db.create_note(None).unwrap().id;
        let mid = db.create_note(None).unwrap().id;
        // Done order differs from edit order: `old` was edited last.
        db.set_completed(&mid, true, 200).unwrap();
        db.set_completed(&new, true, 300).unwrap();
        db.set_completed(&old, true, 100).unwrap();
        db.save_content(&old, FIXTURE).unwrap();
        let ids: Vec<_> = db
            .list_notes(NoteFilter::Completed, None)
            .unwrap()
            .into_iter()
            .map(|n| n.id)
            .collect();
        assert_eq!(ids, vec![new, mid, old]);
    }

    #[test]
    fn completing_refuses_trashed_and_unknown_notes_like_archiving() {
        let db = db();
        let id = db.create_note(None).unwrap().id;
        db.trash_note(&id).unwrap();
        let err = db.set_completed(&id, true, 1).unwrap_err();
        assert_eq!(err.code(), "not_allowed");
        assert_eq!(
            err.to_string(),
            db.set_archived(&id, true).unwrap_err().to_string()
        );
        assert_eq!(db.get_note(&id).unwrap().completed_at, None);
        assert_eq!(
            db.set_completed("missing", true, 1).unwrap_err().code(),
            "not_found"
        );
    }

    #[test]
    fn lists_follow_precedence() {
        let db = db();
        // Every combination of deleted / archived / completed.
        let mut expected: Vec<(String, NoteFilter)> = Vec::new();
        for mask in 0..8u8 {
            let (deleted, archived, completed) = (mask & 4 != 0, mask & 2 != 0, mask & 1 != 0);
            let id = db.create_note(None).unwrap().id;
            if completed {
                db.set_completed(&id, true, 100).unwrap();
            }
            if archived {
                db.set_archived(&id, true).unwrap();
            }
            if deleted {
                db.trash_note(&id).unwrap();
            }
            let list = if deleted {
                NoteFilter::Trash
            } else if archived {
                NoteFilter::Archived
            } else if completed {
                NoteFilter::Completed
            } else {
                NoteFilter::Active
            };
            expected.push((id, list));
        }
        for filter in [
            NoteFilter::Active,
            NoteFilter::Completed,
            NoteFilter::Archived,
            NoteFilter::Trash,
        ] {
            let mut got: Vec<_> = db
                .list_notes(filter, None)
                .unwrap()
                .into_iter()
                .map(|n| n.id)
                .collect();
            let mut want: Vec<_> = expected
                .iter()
                .filter(|(_, f)| *f == filter)
                .map(|(id, _)| id.clone())
                .collect();
            got.sort();
            want.sort();
            assert_eq!(got, want, "{filter:?}");
        }
        // Each of the eight notes is counted once: 1 active, 1 done, 2 archived, 4 trashed.
        assert_eq!(counts(&db), (1, 1, 2, 4));

        // Done, then archive, then unarchive: back in Completed, date kept.
        let id = db.create_note(None).unwrap().id;
        db.set_completed(&id, true, 777).unwrap();
        db.set_archived(&id, true).unwrap();
        assert_eq!(db.get_note(&id).unwrap().completed_at, Some(777));
        db.set_archived(&id, false).unwrap();
        let rows = db.list_notes(NoteFilter::Completed, None).unwrap();
        let row = rows.iter().find(|n| n.id == id).unwrap();
        assert_eq!(row.completed_at, Some(777));
        // Done, then trash, then restore: back in Completed.
        db.trash_note(&id).unwrap();
        db.restore_note(&id).unwrap();
        assert!(
            db.list_notes(NoteFilter::Completed, None)
                .unwrap()
                .iter()
                .any(|n| n.id == id)
        );
        // Reopen: back in Active.
        db.set_completed(&id, false, 800).unwrap();
        assert!(
            db.list_notes(NoteFilter::Active, None)
                .unwrap()
                .iter()
                .any(|n| n.id == id)
        );
    }

    #[test]
    fn search_works_on_the_completed_filter() {
        let db = db();
        let a = db.create_note(None).unwrap().id;
        db.save_content(&a, &doc("buy milk")).unwrap();
        db.set_completed(&a, true, 1).unwrap();
        let b = db.create_note(None).unwrap().id;
        db.save_content(&b, &doc("buy bread")).unwrap();
        db.set_completed(&b, true, 1).unwrap();
        let c = db.create_note(None).unwrap().id;
        db.save_content(&c, &doc("buy milk later")).unwrap();
        let hits = db.list_notes(NoteFilter::Completed, Some("milk")).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].id, a);
        assert!(hits[0].snippet.is_some());
    }

    #[test]
    fn startup_skips_done_notes() {
        let db = db();
        let shown = db.create_note(None).unwrap().id;
        let done = db.create_note(None).unwrap().id;
        db.set_completed(&done, true, 1).unwrap();
        let (notes, unreadable) = db.notes_to_show().unwrap();
        assert!(unreadable.is_empty());
        assert_eq!(notes.iter().map(|n| &n.id).collect::<Vec<_>>(), [&shown]);
        // Restoring a done note from the trash makes its window visible again, but
        // it still does not open at start-up.
        db.trash_note(&done).unwrap();
        db.restore_note(&done).unwrap();
        let (notes, _) = db.notes_to_show().unwrap();
        assert_eq!(notes.len(), 1);
    }

    #[test]
    fn duplicate_is_not_done() {
        let db = db();
        let id = db.create_note(None).unwrap().id;
        db.set_completed(&id, true, 42).unwrap();
        let copy = db.duplicate_note(&id).unwrap();
        assert_eq!(copy.completed_at, None);
        assert_eq!(db.get_note(&id).unwrap().completed_at, Some(42));
        assert_eq!(counts(&db), (1, 1, 0, 0));
    }

    #[test]
    fn migration_7_adds_completed_at_and_keeps_every_note_and_reminder() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("desknotes.db");
        let backups = dir.path().join("backups");
        let content = r#"{"type":"doc","content":[{"type":"paragraph"}]}"#;
        {
            let mut conn = Connection::open(&path).unwrap();
            migrations::apply_until(&mut conn, 0, 6).unwrap();
            for (id, title, archived) in [
                ("2f1c8f0e-6a8b-4c51-9d4e-2b8f5f1a9c3d", "v6 note", "NULL"),
                ("3a2d9e1f-7b9c-4d62-8e5f-3c9a6b2b0d4e", "v6 archived", "9"),
            ] {
                conn.execute_batch(&format!(
                    "INSERT INTO notes (id, title, content_json, color, created_at, updated_at, archived_at)
                     VALUES ('{id}', '{title}', '{content}', '#fff4a3', 1, 7, {archived});
                     INSERT INTO note_windows (note_id, width, height) VALUES ('{id}', 300, 280);"
                ))
                .unwrap();
            }
            conn.execute_batch(
                "INSERT INTO reminders VALUES
                 ('2f1c8f0e-6a8b-4c51-9d4e-2b8f5f1a9c3d', '2026-11-04', '14:00', 'none',
                  1793797200000, NULL, NULL);",
            )
            .unwrap();
        }

        let db = Database::open(&path, &backups).unwrap();
        assert_eq!(db.schema_version().unwrap(), crate::db::LATEST_VERSION);
        assert_eq!(db.count_all_notes().unwrap(), 2);
        let note = db.get_note("2f1c8f0e-6a8b-4c51-9d4e-2b8f5f1a9c3d").unwrap();
        assert_eq!((note.title.as_str(), note.updated_at), ("v6 note", 7));
        assert_eq!(note.completed_at, None, "every note stays not done");
        assert_eq!(counts(&db), (1, 0, 1, 0));
        let reminder = db
            .reminder("2f1c8f0e-6a8b-4c51-9d4e-2b8f5f1a9c3d")
            .unwrap()
            .unwrap();
        assert_eq!(reminder.due_at, 1_793_797_200_000);
        // The safety copy was taken before the upgrade.
        let copies: Vec<_> = std::fs::read_dir(&backups).unwrap().collect();
        assert_eq!(copies.len(), 1);
        let name = copies[0].as_ref().unwrap().file_name();
        assert!(name.to_string_lossy().starts_with("pre-migration-v6-"));
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
    fn window_size_can_be_set_while_collapsed() {
        let db = db();
        let id = db.create_note(None).unwrap().id;
        db.set_window_geometry(&id, Some((10.0, 20.0)), 300.0, 280.0)
            .unwrap();
        db.set_collapsed(&id, true).unwrap();
        db.set_window_size(&id, 360.0, 400.0).unwrap();
        let w = db.get_note(&id).unwrap().window;
        // The size is the expanded one; the position is untouched.
        assert!(w.collapsed);
        assert_eq!(
            (w.x, w.y, w.width, w.height),
            (Some(10.0), Some(20.0), 360.0, 400.0)
        );
        assert!(db.set_window_size(&id, f64::NAN, 300.0).is_ok());
        assert!(db.set_window_size("missing", 300.0, 300.0).is_err());
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

    fn styled() -> Appearance {
        Appearance {
            font: Some("Ubuntu Mono".into()),
            font_size: Some(18),
            text_color: Some("#1d4f91".into()),
            line_spacing: Some(150),
            direction: Some(TextDirection::Rtl),
            opacity: Some(90),
        }
    }

    #[test]
    fn migration_5_gives_existing_notes_default_appearance() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("desknotes.db");
        let backups = dir.path().join("backups");
        let content = r#"{"type":"doc","content":[{"type":"paragraph"}]}"#;
        {
            let mut conn = Connection::open(&path).unwrap();
            migrations::apply_until(&mut conn, 0, 4).unwrap();
            conn.execute_batch(&format!(
                "INSERT INTO notes (id, title, content_json, color, created_at, updated_at)
                 VALUES ('2f1c8f0e-6a8b-4c51-9d4e-2b8f5f1a9c3d', 'v4 note', '{content}',
                         '#fff4a3', 1, 7);
                 INSERT INTO note_windows (note_id, width, height)
                 VALUES ('2f1c8f0e-6a8b-4c51-9d4e-2b8f5f1a9c3d', 300, 280);"
            ))
            .unwrap();
        }

        let db = Database::open(&path, &backups).unwrap();
        assert_eq!(db.schema_version().unwrap(), crate::db::LATEST_VERSION);
        let note = db.get_note("2f1c8f0e-6a8b-4c51-9d4e-2b8f5f1a9c3d").unwrap();
        assert_eq!(note.appearance, Appearance::default());
        assert_eq!(note.title, "v4 note");
        assert_eq!(note.updated_at, 7);
        assert_eq!(
            serde_json::to_string(&note.content).unwrap(),
            serde_json::to_string(&serde_json::from_str::<serde_json::Value>(content).unwrap())
                .unwrap()
        );
    }

    #[test]
    fn set_appearance_round_trips_without_touching_updated_at() {
        let db = db();
        let note = db.create_note(None).unwrap();
        db.set_appearance(&note.id, &styled()).unwrap();
        let after = db.get_note(&note.id).unwrap();
        assert_eq!(after.appearance, styled());
        assert_eq!(after.updated_at, note.updated_at);
        assert_eq!(after.content, note.content);

        // Values are normalised on the way in, and the default clears the style.
        let loose = Appearance {
            font: Some("  Lato ".into()),
            text_color: Some("#8C491A".into()),
            ..Default::default()
        };
        db.set_appearance(&note.id, &loose).unwrap();
        let a = db.get_note(&note.id).unwrap().appearance;
        assert_eq!(a.font.as_deref(), Some("Lato"));
        assert_eq!(a.text_color.as_deref(), Some("#8c491a"));
        db.set_appearance(&note.id, &Appearance::default()).unwrap();
        assert_eq!(
            db.get_note(&note.id).unwrap().appearance,
            Appearance::default()
        );
    }

    #[test]
    fn set_appearance_refuses_invalid_and_unknown_note() {
        let db = db();
        let id = db.create_note(None).unwrap().id;
        db.set_appearance(&id, &styled()).unwrap();
        let bad = Appearance {
            font_size: Some(99),
            ..Default::default()
        };
        assert_eq!(
            db.set_appearance(&id, &bad).unwrap_err().code(),
            "validation"
        );
        assert_eq!(db.get_note(&id).unwrap().appearance, styled());
        assert_eq!(
            db.set_appearance("missing", &styled()).unwrap_err().code(),
            "not_found"
        );
    }

    #[test]
    fn damaged_appearance_in_the_database_opens_with_defaults() {
        let db = db();
        let id = db.create_note(None).unwrap().id;
        for raw in [r#"{"fontSize":99}"#, "not json"] {
            db.conn
                .execute("UPDATE notes SET appearance = ?2 WHERE id = ?1", [&id, raw])
                .unwrap();
            let note = db.get_note(&id).unwrap();
            assert_eq!(note.appearance, Appearance::default(), "{raw}");
            let (shown, unreadable) = db.notes_to_show().unwrap();
            assert!(unreadable.is_empty(), "{raw}");
            assert_eq!(shown.len(), 1, "{raw}");
            assert_eq!(shown[0].id, id);
        }
    }

    #[test]
    fn duplicate_keeps_appearance() {
        let db = db();
        let id = db.create_note(None).unwrap().id;
        db.set_appearance(&id, &styled()).unwrap();
        let copy = db.duplicate_note(&id).unwrap();
        assert_ne!(copy.id, id);
        assert_eq!(copy.appearance, styled());
    }

    #[test]
    fn locked_private_note_keeps_its_appearance() {
        let db = db();
        let id = db.create_note(None).unwrap().id;
        db.set_appearance(&id, &styled()).unwrap();
        db.set_private(&id, true, "Bank").unwrap();
        db.set_setting(PIN_HASH, "stand-in").unwrap();
        db.set_privacy_locked(true, &[]);

        let note = db.get_note(&id).unwrap();
        assert!(note.locked);
        assert_eq!(note.appearance, styled());
        let (shown, _) = db.notes_to_show().unwrap();
        assert_eq!(shown[0].appearance, styled());

        let changed = Appearance {
            font_size: Some(20),
            ..Default::default()
        };
        db.set_appearance(&id, &changed).unwrap();
        assert_eq!(db.get_note(&id).unwrap().appearance, changed);
    }
}
