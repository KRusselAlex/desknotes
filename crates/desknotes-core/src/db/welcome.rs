//! The welcome note a brand-new database gets once (DES-29).

use serde_json::{Value, json};

use super::Database;
use super::settings::FIRST_RUN_DONE;
use crate::error::CoreResult;
use crate::model::{Appearance, DEFAULT_COLOR, DEFAULT_HEIGHT, DEFAULT_WIDTH, Note, NoteWindow};
use crate::validation::empty_doc;

fn text(text: &str) -> Value {
    json!({ "type": "text", "text": text })
}

fn bold(text: &str) -> Value {
    json!({ "type": "text", "marks": [{ "type": "bold" }], "text": text })
}

fn paragraph(content: Vec<Value>) -> Value {
    json!({ "type": "paragraph", "content": content })
}

/// The welcome note's content: four plain paragraphs, with bold on two phrases.
/// Only nodes and marks on the validation allowlist are used.
pub fn welcome_content() -> Value {
    json!({
        "type": "doc",
        "content": [
            paragraph(vec![bold("Welcome \u{1F44B}")]),
            paragraph(vec![
                text("DeskNotes keeps your notes "),
                bold("on this computer only"),
                text(". Nothing goes online."),
            ]),
            paragraph(vec![text(
                "Use the palette on my top bar to change my colour. Delete me when you're done.",
            )]),
            paragraph(vec![text("\u{2014} Alex")]),
        ]
    })
}

impl Database {
    /// True when the database file was new (schema version 0) when this
    /// connection was opened.
    pub fn was_created_new(&self) -> bool {
        self.created_new
    }

    /// Create the welcome note, once, on a database that was new when opened.
    ///
    /// Returns `None` and writes nothing unless the database was created new, the
    /// `notes` table holds no row in any state, and [`FIRST_RUN_DONE`] is unset.
    /// The note is created and its content saved through [`Database::save_content`]
    /// (the same validation and title/search derivation as an edit), and the
    /// setting is written, all in one transaction.
    pub fn create_welcome_note(&self) -> CoreResult<Option<Note>> {
        if !self.created_new {
            return Ok(None);
        }
        let tx = self.conn.unchecked_transaction()?;
        let any_note: bool =
            tx.query_row("SELECT EXISTS (SELECT 1 FROM notes)", [], |r| r.get(0))?;
        if any_note || self.get_setting(FIRST_RUN_DONE)?.is_some() {
            return Ok(None);
        }
        let window = NoteWindow {
            x: None,
            y: None,
            width: DEFAULT_WIDTH,
            height: DEFAULT_HEIGHT,
            visible: true,
            always_on_top: false,
            collapsed: false,
        };
        let id = Self::insert_note_in(
            &tx,
            &empty_doc(),
            DEFAULT_COLOR,
            &window,
            false,
            "",
            &Appearance::default(),
        )?;
        self.save_content_in(&tx, &id, &welcome_content().to_string())?;
        self.set_setting(FIRST_RUN_DONE, "1")?;
        tx.commit()?;
        self.get_note(&id).map(Some)
    }
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use serde_json::Value;

    use crate::model::DEFAULT_COLOR;
    use crate::validation::validate_doc;

    use super::*;

    const LINES: [&str; 4] = [
        "**Welcome 👋**",
        "DeskNotes keeps your notes **on this computer only**. Nothing goes online.",
        "Use the palette on my top bar to change my colour. Delete me when you're done.",
        "— Alex",
    ];

    fn open(path: &Path) -> Database {
        Database::open(path, &path.with_extension("backups")).unwrap()
    }

    fn all_note_ids(db: &Database) -> Vec<String> {
        let mut stmt = db.conn.prepare("SELECT id FROM notes").unwrap();
        stmt.query_map([], |r| r.get(0))
            .unwrap()
            .map(Result::unwrap)
            .collect()
    }

    #[test]
    fn welcome_is_created_once() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("desknotes.db");
        let db = open(&path);
        assert!(db.was_created_new());
        let note = db.create_welcome_note().unwrap().expect("a new database");
        assert_eq!(db.get_note(&note.id).unwrap().id, note.id);
        assert!(db.create_welcome_note().unwrap().is_none(), "second call");
        drop(db);

        let db = open(&path);
        assert!(!db.was_created_new());
        assert!(db.create_welcome_note().unwrap().is_none(), "after reopen");
        assert_eq!(all_note_ids(&db), vec![note.id.clone()]);

        db.trash_note(&note.id).unwrap();
        db.purge_note(&note.id).unwrap();
        assert!(all_note_ids(&db).is_empty());
        drop(db);

        let db = open(&path);
        assert!(
            db.create_welcome_note().unwrap().is_none(),
            "deleted for good, still never again"
        );
        assert!(all_note_ids(&db).is_empty());
    }

    /// Same connection: `created_new` is still true and the table is empty again,
    /// so only the `first_run_done` flag can refuse a second welcome note.
    #[test]
    fn flag_alone_refuses_a_second_welcome() {
        let dir = tempfile::tempdir().unwrap();
        let db = open(&dir.path().join("desknotes.db"));
        let note = db.create_welcome_note().unwrap().expect("a new database");
        db.trash_note(&note.id).unwrap();
        db.purge_note(&note.id).unwrap();
        assert!(all_note_ids(&db).is_empty());
        assert!(db.was_created_new());

        assert!(db.create_welcome_note().unwrap().is_none());
        assert_eq!(
            db.get_setting(FIRST_RUN_DONE).unwrap().as_deref(),
            Some("1")
        );
        assert!(all_note_ids(&db).is_empty(), "nothing was written");
    }

    #[test]
    fn flag_set_on_an_empty_new_database_gives_no_welcome() {
        let db = Database::open_in_memory().unwrap();
        db.set_setting(FIRST_RUN_DONE, "1").unwrap();
        assert!(db.was_created_new());
        assert!(db.create_welcome_note().unwrap().is_none());
        assert!(all_note_ids(&db).is_empty());
    }

    /// "Any note" means any state: archived, in the trash and completed notes count.
    #[test]
    fn a_note_in_any_state_blocks_the_welcome() {
        type PutInState = fn(&Database, &str);
        let states: [(&str, PutInState); 4] = [
            ("active", |_, _| {}),
            ("archived", |db, id| db.set_archived(id, true).unwrap()),
            ("trashed", |db, id| db.trash_note(id).unwrap()),
            ("completed", |db, id| db.set_completed(id, true, 1).unwrap()),
        ];
        for (name, put_in_state) in states {
            let db = Database::open_in_memory().unwrap();
            let note = db.create_note(None).unwrap();
            put_in_state(&db, &note.id);
            assert!(db.was_created_new(), "{name}");
            assert!(db.create_welcome_note().unwrap().is_none(), "{name}");
            assert_eq!(db.get_setting(FIRST_RUN_DONE).unwrap(), None, "{name}");
            assert_eq!(all_note_ids(&db), vec![note.id], "{name}");
        }
    }

    /// If the flag cannot be written, the note is not kept either.
    #[test]
    fn a_failed_flag_write_rolls_the_note_back() {
        let db = Database::open_in_memory().unwrap();
        db.conn
            .execute_batch(
                "CREATE TEMP TRIGGER refuse_flag BEFORE INSERT ON settings \
                 WHEN NEW.key = 'first_run_done' BEGIN SELECT RAISE(ABORT, 'no'); END;",
            )
            .unwrap();

        assert!(db.create_welcome_note().is_err());
        assert!(all_note_ids(&db).is_empty(), "the note was rolled back");
        assert_eq!(db.get_setting(FIRST_RUN_DONE).unwrap(), None);
        let windows: i64 = db
            .conn
            .query_row("SELECT count(*) FROM note_windows", [], |r| r.get(0))
            .unwrap();
        assert_eq!(windows, 0);
    }

    #[test]
    fn existing_database_gets_no_welcome() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("desknotes.db");
        drop(open(&path));
        let db = open(&path);
        assert!(!db.was_created_new());
        assert!(db.create_welcome_note().unwrap().is_none());
        assert!(all_note_ids(&db).is_empty());
        assert_eq!(db.get_setting(FIRST_RUN_DONE).unwrap(), None);
    }

    #[test]
    fn new_database_with_notes_gets_no_welcome() {
        let db = Database::open_in_memory().unwrap();
        assert!(db.was_created_new());
        db.create_note(None).unwrap();
        assert!(db.create_welcome_note().unwrap().is_none());
        assert_eq!(db.get_setting(FIRST_RUN_DONE).unwrap(), None);
    }

    fn collect(
        node: &Value,
        nodes: &mut Vec<String>,
        marks: &mut Vec<String>,
        lines: &mut Vec<String>,
    ) {
        let kind = node["type"].as_str().unwrap().to_string();
        if kind == "paragraph" {
            lines.push(String::new());
        }
        if kind == "text" {
            lines
                .last_mut()
                .unwrap()
                .push_str(node["text"].as_str().unwrap());
        }
        for mark in node["marks"].as_array().into_iter().flatten() {
            marks.push(mark["type"].as_str().unwrap().to_string());
        }
        nodes.push(kind);
        for child in node["content"].as_array().into_iter().flatten() {
            collect(child, nodes, marks, lines);
        }
    }

    /// Each paragraph's text runs, with bold runs wrapped in `**`.
    fn render_marked(doc: &Value) -> Vec<String> {
        doc["content"]
            .as_array()
            .unwrap()
            .iter()
            .map(|para| {
                assert_eq!(para["type"], "paragraph");
                para["content"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|run| {
                        let text = run["text"].as_str().unwrap();
                        let bold = run["marks"]
                            .as_array()
                            .is_some_and(|m| m.iter().any(|m| m["type"] == "bold"));
                        if bold {
                            format!("**{text}**")
                        } else {
                            text.to_string()
                        }
                    })
                    .collect::<String>()
            })
            .collect()
    }

    #[test]
    fn welcome_content_bolds_exactly_the_right_phrases() {
        let db = Database::open_in_memory().unwrap();
        let note = db.create_welcome_note().unwrap().expect("a new database");
        assert_eq!(render_marked(&note.content), LINES);
    }

    #[test]
    fn welcome_content_is_plain_and_valid() {
        let db = Database::open_in_memory().unwrap();
        let note = db.create_welcome_note().unwrap().expect("a new database");

        validate_doc(&welcome_content()).unwrap();
        let (mut nodes, mut marks, mut lines) = (vec![], vec![], vec![]);
        collect(&note.content, &mut nodes, &mut marks, &mut lines);
        for kind in &nodes {
            assert!(
                ["doc", "paragraph", "text"].contains(&kind.as_str()),
                "{kind}"
            );
        }
        for mark in &marks {
            assert_eq!(mark, "bold");
        }
        let expected: Vec<String> = LINES.iter().map(|l| l.replace("**", "")).collect();
        assert_eq!(lines.join("\n"), expected.join("\n"));
        assert_eq!(marks.len(), 2, "two bold phrases");
        assert_eq!(note.content, welcome_content());

        // Saved through the same derivation as any other save.
        assert_eq!(note.title, "Welcome 👋");
        assert_eq!(note.color, DEFAULT_COLOR);
        assert!(!note.private && !note.edit_locked);
        assert_eq!(
            db.get_setting(FIRST_RUN_DONE).unwrap().as_deref(),
            Some("1")
        );
        let search: String = db
            .conn
            .query_row(
                "SELECT search_text FROM notes WHERE id = ?1",
                [&note.id],
                |r| r.get(0),
            )
            .unwrap();
        assert!(search.contains("nothing goes online"));
    }
}
