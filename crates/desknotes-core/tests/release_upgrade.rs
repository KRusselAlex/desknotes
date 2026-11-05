//! Upgrade test with a real database from the previous release (safe-updates
//! design §3.1). `tests/fixtures/release-0.2.0.db` was written by the v0.2.0
//! release's own code (`scripts/release/make-fixture.sh v0.2.0`), and the JSON
//! manifest next to it lists what it holds. Opening a copy with today's code must
//! keep every note and setting, reach the latest schema and leave exactly one
//! byte-identical pre-migration copy.

use std::fs;
use std::path::{Path, PathBuf};

use desknotes_core::Database;
use desknotes_core::db::LATEST_VERSION;
use rusqlite::{Connection, OpenFlags};
use serde_json::Value;

/// `PRAGMA user_version` of v0.2.0 (its three migrations).
const RELEASE_0_2_0_VERSION: i64 = 3;

fn fixtures_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures")
}

fn fixture_db() -> PathBuf {
    fixtures_dir().join("release-0.2.0.db")
}

fn manifest() -> Value {
    let raw = fs::read_to_string(fixtures_dir().join("release-0.2.0.json"))
        .expect("read release-0.2.0.json");
    serde_json::from_str(&raw).expect("manifest is JSON")
}

#[test]
fn fixture_is_from_release_0_2_0() {
    let conn = Connection::open_with_flags(fixture_db(), OpenFlags::SQLITE_OPEN_READ_ONLY)
        .expect("open the fixture read-only");
    let version: i64 = conn
        .query_row("PRAGMA user_version", [], |r| r.get(0))
        .unwrap();
    assert_eq!(version, RELEASE_0_2_0_VERSION);
    let manifest = manifest();
    assert_eq!(manifest["release"], "v0.2.0");
    assert_eq!(manifest["schema_version"], RELEASE_0_2_0_VERSION);
}

#[test]
fn upgrade_from_release_0_2_0_keeps_everything() {
    let dir = tempfile::tempdir().unwrap();
    let db_path = dir.path().join("desknotes.db");
    let backups = dir.path().join("backups");
    fs::copy(fixture_db(), &db_path).unwrap();

    let db = Database::open(&db_path, &backups).expect("today's code opens the v0.2.0 database");
    assert_eq!(db.schema_version().unwrap(), LATEST_VERSION);

    let manifest = manifest();
    let notes = manifest["notes"].as_array().expect("notes array");
    assert!(
        notes.len() >= 5,
        "fixture holds active, archived and trashed"
    );
    for expected in notes {
        let id = expected["id"].as_str().unwrap();
        let note = db.get_note(id).unwrap_or_else(|e| panic!("note {id}: {e}"));

        assert_eq!(
            note.title,
            expected["title"].as_str().unwrap(),
            "{id} title"
        );
        let stored: Value = serde_json::from_str(expected["content_json"].as_str().unwrap())
            .expect("manifest content_json is JSON");
        assert_eq!(note.content, stored, "{id} content");
        assert_eq!(
            note.color,
            expected["color"].as_str().unwrap(),
            "{id} color"
        );
        assert_eq!(
            note.edit_locked,
            expected["edit_locked"].as_bool().unwrap(),
            "{id} edit_locked"
        );

        assert_eq!(
            note.archived_at.is_some(),
            expected["archived"].as_bool().unwrap(),
            "{id} archived"
        );
        assert_eq!(
            note.deleted_at.is_some(),
            expected["trashed"].as_bool().unwrap(),
            "{id} trashed"
        );
        assert_eq!(note.created_at, expected["created_at"].as_i64().unwrap());
        assert_eq!(note.updated_at, expected["updated_at"].as_i64().unwrap());
        assert_eq!(note.archived_at, expected["archived_at"].as_i64());
        assert_eq!(note.deleted_at, expected["deleted_at"].as_i64());

        let w = &expected["window"];
        assert_eq!(note.window.x, w["x"].as_f64(), "{id} x");
        assert_eq!(note.window.y, w["y"].as_f64(), "{id} y");
        assert_eq!(
            note.window.width,
            w["width"].as_f64().unwrap(),
            "{id} width"
        );
        assert_eq!(
            note.window.height,
            w["height"].as_f64().unwrap(),
            "{id} height"
        );
        assert_eq!(
            note.window.visible,
            w["visible"].as_bool().unwrap(),
            "{id} visible"
        );
        assert_eq!(
            note.window.always_on_top,
            w["always_on_top"].as_bool().unwrap(),
            "{id} always_on_top"
        );
        assert_eq!(
            note.window.collapsed,
            w["collapsed"].as_bool().unwrap(),
            "{id} collapsed"
        );
    }

    // No note appeared or went missing.
    let counts = db.count_notes().unwrap();
    let count = |f: fn(&Value) -> bool| notes.iter().filter(|n| f(n)).count() as i64;
    assert_eq!(
        counts.trash,
        count(|n| n["trashed"].as_bool().unwrap()),
        "trash count"
    );
    assert_eq!(
        counts.archived,
        count(|n| n["archived"].as_bool().unwrap() && !n["trashed"].as_bool().unwrap()),
        "archived count"
    );
    assert_eq!(
        counts.active,
        count(|n| !n["archived"].as_bool().unwrap() && !n["trashed"].as_bool().unwrap()),
        "active count"
    );

    // Settings: raw stored values, plus the typed getters that read them.
    let settings = manifest["settings"].as_object().expect("settings object");
    assert!(!settings.is_empty(), "fixture holds settings");
    for (key, value) in settings {
        assert_eq!(
            db.get_setting(key).unwrap().as_deref(),
            Some(value.as_str().unwrap()),
            "setting {key}"
        );
    }
    assert_eq!(
        db.new_note_color().unwrap(),
        settings["new_note_color"].as_str().unwrap()
    );
    let size: Value = serde_json::from_str(settings["min_note_size"].as_str().unwrap()).unwrap();
    let min = db.min_note_size().unwrap();
    assert_eq!(i64::from(min.width), size["width"].as_i64().unwrap());
    assert_eq!(i64::from(min.height), size["height"].as_i64().unwrap());
    let hidden: Vec<String> =
        serde_json::from_str(settings["hidden_by_hide_all"].as_str().unwrap()).unwrap();
    assert_eq!(db.hidden_by_hide_all().unwrap(), hidden);

    // Exactly one pre-migration copy, taken at the old version, holding exactly what
    // the user had. (Not compared byte for byte: the copy is made with VACUUM INTO,
    // which always bumps the file's schema cookie, so no copy of any file is
    // byte-identical. Schema and every row are compared instead.)
    let copies: Vec<PathBuf> = fs::read_dir(&backups)
        .unwrap()
        .map(|e| e.unwrap().path())
        .collect();
    assert_eq!(
        copies.len(),
        1,
        "exactly one pre-migration backup: {copies:?}"
    );
    let name = copies[0]
        .file_name()
        .unwrap()
        .to_string_lossy()
        .into_owned();
    assert!(name.starts_with("pre-migration-v3-"), "{name}");
    let backup = Connection::open_with_flags(&copies[0], OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    let version: i64 = backup
        .query_row("PRAGMA user_version", [], |r| r.get(0))
        .unwrap();
    assert_eq!(
        version, RELEASE_0_2_0_VERSION,
        "backup keeps the old schema"
    );
    let original =
        Connection::open_with_flags(fixture_db(), OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    let before = dump(&original);
    assert!(
        before.iter().any(|l| l.starts_with("notes: ")),
        "the dump covers the notes table"
    );
    assert_eq!(
        dump(&backup),
        before,
        "the backup holds the same schema and rows as the v0.2.0 database"
    );
}

/// Every table's SQL and every row, in a stable order, as comparable text.
fn dump(conn: &Connection) -> Vec<String> {
    let mut tables: Vec<(String, String)> = conn
        .prepare(
            "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
        )
        .unwrap()
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
        .unwrap()
        .map(Result::unwrap)
        .collect();
    tables.sort();
    let mut lines = Vec::new();
    for (name, sql) in tables {
        lines.push(format!("{name} schema: {sql}"));
        let mut stmt = conn
            .prepare(&format!("SELECT * FROM \"{name}\" ORDER BY 1"))
            .unwrap();
        let columns = stmt.column_count();
        let rows = stmt
            .query_map([], |r| {
                (0..columns)
                    .map(|i| r.get::<_, rusqlite::types::Value>(i))
                    .collect::<Result<Vec<_>, _>>()
            })
            .unwrap();
        for row in rows {
            lines.push(format!("{name}: {:?}", row.unwrap()));
        }
    }
    lines
}
