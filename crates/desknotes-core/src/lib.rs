//! Platform-independent core of DeskNotes.
//!
//! Everything here builds and tests without a desktop session: models, rich-text
//! validation, geometry rules and the SQLite repository. The Tauri app in
//! `src-tauri` is a thin adapter around this crate (see docs/adr/0001).

pub mod db;
pub mod error;
pub mod geometry;
pub mod model;
pub mod validation;

pub use db::Database;
pub use error::{CoreError, CoreResult};
pub use model::*;

/// Current time as Unix milliseconds (UTC).
pub fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
