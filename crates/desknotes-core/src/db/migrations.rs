//! Versioned schema migrations, tracked with `PRAGMA user_version`.
//!
//! Rules: never edit a migration that has shipped; append a new one instead.
//! Never drop user data in a migration.

use rusqlite::Connection;

use crate::error::CoreResult;

const MIGRATIONS: &[&str] = &[
    // v1 — notes, window state, settings
    r#"
    CREATE TABLE notes (
        id            TEXT PRIMARY KEY NOT NULL,
        title         TEXT NOT NULL DEFAULT '',
        content_json  TEXT NOT NULL,
        search_text   TEXT NOT NULL DEFAULT '',
        color         TEXT NOT NULL,
        created_at    INTEGER NOT NULL,
        updated_at    INTEGER NOT NULL,
        archived_at   INTEGER,
        deleted_at    INTEGER
    );
    CREATE INDEX notes_updated_at ON notes(updated_at DESC);

    CREATE TABLE note_windows (
        note_id       TEXT PRIMARY KEY NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
        x             REAL,
        y             REAL,
        width         REAL NOT NULL,
        height        REAL NOT NULL,
        visible       INTEGER NOT NULL DEFAULT 1,
        always_on_top INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE settings (
        key   TEXT PRIMARY KEY NOT NULL,
        value TEXT NOT NULL
    );
    "#,
    // v2 — read-only ("edit lock") flag per note
    r#"
    ALTER TABLE notes ADD COLUMN edit_locked INTEGER NOT NULL DEFAULT 0;
    "#,
    // v3 — note rolled up to its header strip
    r#"
    ALTER TABLE note_windows ADD COLUMN collapsed INTEGER NOT NULL DEFAULT 0;
    "#,
    // v4 — private flag and the neutral label shown instead of the title
    r#"
    ALTER TABLE notes ADD COLUMN private INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE notes ADD COLUMN private_label TEXT NOT NULL DEFAULT '';
    "#,
    // v5 — per-note text styling and window opacity, a JSON object ('{}' = defaults)
    r#"
    ALTER TABLE notes ADD COLUMN appearance TEXT NOT NULL DEFAULT '{}';
    "#,
    // v6 — one reminder per note. Times are UTC ms; the local date, time and repeat are
    // kept so a repeat stays at the same wall-clock time. No existing data changes.
    r#"
    CREATE TABLE reminders (
        note_id        TEXT PRIMARY KEY NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
        local_date     TEXT NOT NULL,
        local_time     TEXT NOT NULL,
        repeat         TEXT NOT NULL,
        due_at         INTEGER NOT NULL,
        snoozed_until  INTEGER,
        fired_at       INTEGER
    );
    "#,
    // v7 — when a note was marked done (UTC ms); NULL = not done. No existing data changes.
    r#"
    ALTER TABLE notes ADD COLUMN completed_at INTEGER;
    "#,
];

pub const LATEST_VERSION: i64 = MIGRATIONS.len() as i64;

/// Apply every migration after `current`, each in its own transaction.
pub fn apply(conn: &mut Connection, current: i64) -> CoreResult<()> {
    apply_until(conn, current, LATEST_VERSION)
}

/// Apply migrations after `current` up to and including `target`.
pub(crate) fn apply_until(conn: &mut Connection, current: i64, target: i64) -> CoreResult<()> {
    let count = (target - current).max(0) as usize;
    for (index, sql) in MIGRATIONS
        .iter()
        .enumerate()
        .skip(current as usize)
        .take(count)
    {
        let version = index as i64 + 1;
        let tx = conn.transaction()?;
        tx.execute_batch(sql)?;
        tx.pragma_update(None, "user_version", version)?;
        tx.commit()?;
    }
    Ok(())
}
