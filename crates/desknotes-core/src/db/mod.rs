//! SQLite persistence (docs/adr/0003). All SQL in DeskNotes lives under this module.

mod migrations;
mod notes;
mod settings;

use std::path::{Path, PathBuf};

use rusqlite::Connection;

use crate::error::{CoreError, CoreResult};

pub use migrations::LATEST_VERSION;

pub struct Database {
    conn: Connection,
}

impl Database {
    /// Open (or create) the database at `path` and bring its schema up to date.
    ///
    /// If an existing database needs migrating, a consistent copy is first
    /// written to `backup_dir` so an upgrade can never destroy data.
    pub fn open(path: &Path, backup_dir: &Path) -> CoreResult<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let conn = Connection::open(path)?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        Self::init(conn, Some(backup_dir))
    }

    /// In-memory database, for tests.
    pub fn open_in_memory() -> CoreResult<Self> {
        Self::init(Connection::open_in_memory()?, None)
    }

    fn init(conn: Connection, backup_dir: Option<&Path>) -> CoreResult<Self> {
        conn.pragma_update(None, "foreign_keys", "ON")?;
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        let mut db = Database { conn };
        let version = db.schema_version()?;
        if version > LATEST_VERSION {
            return Err(CoreError::SchemaTooNew {
                found: version,
                supported: LATEST_VERSION,
            });
        }
        if version > 0 && version < LATEST_VERSION {
            if let Some(dir) = backup_dir {
                db.backup_to(&pre_migration_path(dir, version))?;
            }
        }
        migrations::apply(&mut db.conn, version)?;
        Ok(db)
    }

    pub fn schema_version(&self) -> CoreResult<i64> {
        Ok(self
            .conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))?)
    }

    /// Write a consistent snapshot of the whole database to `dest`.
    pub fn backup_to(&self, dest: &Path) -> CoreResult<()> {
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent)?;
        }
        if dest.exists() {
            return Err(CoreError::NotAllowed(format!(
                "refusing to overwrite existing backup {}",
                dest.display()
            )));
        }
        let dest_str = dest
            .to_str()
            .ok_or_else(|| CoreError::Validation("backup path is not valid UTF-8".into()))?;
        self.conn.execute("VACUUM INTO ?1", [dest_str])?;
        Ok(())
    }
}

fn pre_migration_path(dir: &Path, from_version: i64) -> PathBuf {
    dir.join(format!(
        "pre-migration-v{from_version}-{}.db",
        crate::now_ms()
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fresh_database_reaches_latest_version() {
        let db = Database::open_in_memory().unwrap();
        assert_eq!(db.schema_version().unwrap(), LATEST_VERSION);
    }

    #[test]
    fn reopening_keeps_data_and_does_not_back_up() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("desknotes.db");
        let backups = dir.path().join("backups");
        let id = {
            let db = Database::open(&path, &backups).unwrap();
            db.create_note(None).unwrap().id
        };
        let db = Database::open(&path, &backups).unwrap();
        assert_eq!(db.get_note(&id).unwrap().id, id);
        assert!(!backups.exists(), "no migration ran, so no backup expected");
    }

    #[test]
    fn newer_schema_is_refused_and_left_untouched() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("desknotes.db");
        {
            let conn = Connection::open(&path).unwrap();
            conn.pragma_update(None, "user_version", LATEST_VERSION + 1)
                .unwrap();
        }
        let err = Database::open(&path, &dir.path().join("b")).err().unwrap();
        assert_eq!(err.code(), "schema_too_new");
        let conn = Connection::open(&path).unwrap();
        let v: i64 = conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(v, LATEST_VERSION + 1);
    }

    #[test]
    fn upgrade_from_v1_backs_up_first_and_keeps_notes() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("desknotes.db");
        let backups = dir.path().join("backups");
        {
            let mut conn = Connection::open(&path).unwrap();
            migrations::apply_until(&mut conn, 0, 1).unwrap();
            conn.execute_batch(
                "INSERT INTO notes (id, title, content_json, color, created_at, updated_at)
                 VALUES ('2f1c8f0e-6a8b-4c51-9d4e-2b8f5f1a9c3d', 'old note',
                         '{\"type\":\"doc\",\"content\":[{\"type\":\"paragraph\"}]}',
                         '#fff4a3', 1, 1);
                 INSERT INTO note_windows (note_id, width, height)
                 VALUES ('2f1c8f0e-6a8b-4c51-9d4e-2b8f5f1a9c3d', 300, 280);",
            )
            .unwrap();
        }

        let db = Database::open(&path, &backups).unwrap();
        assert_eq!(db.schema_version().unwrap(), LATEST_VERSION);
        let note = db.get_note("2f1c8f0e-6a8b-4c51-9d4e-2b8f5f1a9c3d").unwrap();
        assert_eq!(note.title, "old note");
        assert!(!note.edit_locked);

        let copies: Vec<_> = std::fs::read_dir(&backups).unwrap().collect();
        assert_eq!(copies.len(), 1, "exactly one pre-migration backup");
        let name = copies[0]
            .as_ref()
            .unwrap()
            .file_name()
            .into_string()
            .unwrap();
        assert!(name.starts_with("pre-migration-v1-"), "{name}");
        let conn = Connection::open(copies[0].as_ref().unwrap().path()).unwrap();
        let v: i64 = conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(v, 1, "backup keeps the old schema untouched");
    }

    #[test]
    fn backup_is_a_readable_copy() {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(&dir.path().join("a.db"), dir.path()).unwrap();
        let note = db.create_note(Some("#aabbcc")).unwrap();
        let dest = dir.path().join("copy.db");
        db.backup_to(&dest).unwrap();
        let copy = Database::open(&dest, dir.path()).unwrap();
        assert_eq!(copy.get_note(&note.id).unwrap().color, "#aabbcc");
        assert!(
            db.backup_to(&dest).is_err(),
            "must not overwrite an existing backup"
        );
    }
}
