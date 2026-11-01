use serde::{Deserialize, Serialize};

pub const DEFAULT_COLOR: &str = "#fff4a3";
pub const DEFAULT_WIDTH: f64 = 300.0;
pub const DEFAULT_HEIGHT: f64 = 280.0;
pub const MIN_WIDTH: f64 = 180.0;
pub const MIN_HEIGHT: f64 = 120.0;

/// Where a note window sits and whether it is shown. Logical pixels.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteWindow {
    /// `None` until the window has been placed once; the shell then picks a spot.
    pub x: Option<f64>,
    pub y: Option<f64>,
    pub width: f64,
    pub height: f64,
    pub visible: bool,
    pub always_on_top: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Note {
    pub id: String,
    pub title: String,
    /// Tiptap/ProseMirror JSON document, already validated.
    pub content: serde_json::Value,
    pub color: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub archived_at: Option<i64>,
    pub deleted_at: Option<i64>,
    /// Read-only: content changes are refused until unlocked.
    pub edit_locked: bool,
    pub window: NoteWindow,
}

/// Lightweight row for the manager list (no full content).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteSummary {
    pub id: String,
    pub title: String,
    pub color: String,
    pub updated_at: i64,
    pub archived_at: Option<i64>,
    pub deleted_at: Option<i64>,
    pub visible: bool,
    /// Text around the first match, only when searching.
    pub snippet: Option<String>,
}

/// Number of notes in each manager tab.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct NoteCounts {
    pub active: i64,
    pub archived: i64,
    pub trash: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NoteFilter {
    Active,
    Archived,
    Trash,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveResult {
    pub title: String,
    pub updated_at: i64,
}
