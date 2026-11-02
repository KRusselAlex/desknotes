use serde::{Deserialize, Serialize};

pub const DEFAULT_COLOR: &str = "#fff4a3";
pub const DEFAULT_WIDTH: f64 = 300.0;
pub const DEFAULT_HEIGHT: f64 = 280.0;
pub const MIN_WIDTH: f64 = 180.0;
pub const MIN_HEIGHT: f64 = 120.0;
/// Height of a collapsed note: just its header strip.
pub const COLLAPSED_HEIGHT: f64 = 32.0;
/// Longest private label, in characters.
pub const PRIVATE_LABEL_MAX_CHARS: usize = 40;
/// Shown in place of a private note's title when it has no label of its own.
pub const PRIVATE_FALLBACK_LABEL: &str = "Private note";
/// Largest value the "Minimum note size" setting accepts, per side.
pub const MAX_MIN_NOTE_SIDE: u32 = 600;

/// A note size in whole logical pixels (the "Minimum note size" setting).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct NoteSize {
    pub width: u32,
    pub height: u32,
}

impl NoteSize {
    /// The smallest a note can ever be: the layout does not fit below this.
    pub const FLOOR: NoteSize = NoteSize {
        width: MIN_WIDTH as u32,
        height: MIN_HEIGHT as u32,
    };

    /// True when both sides are between the floor and `MAX_MIN_NOTE_SIDE`.
    pub fn is_valid_minimum(&self) -> bool {
        (Self::FLOOR.width..=MAX_MIN_NOTE_SIDE).contains(&self.width)
            && (Self::FLOOR.height..=MAX_MIN_NOTE_SIDE).contains(&self.height)
    }
}

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
    /// Rolled up to its header strip. `height` keeps the expanded height.
    pub collapsed: bool,
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
    /// Hidden behind the privacy lock while the app is locked.
    pub private: bool,
    /// Neutral name shown instead of the title for a private note.
    pub private_label: String,
    /// True while the privacy lock withholds this note: `content` is then an
    /// empty document and `title` the label (or "Private note"), never the text.
    pub locked: bool,
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
    pub private: bool,
    pub private_label: String,
    /// See [`Note::locked`].
    pub locked: bool,
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
