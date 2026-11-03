//! Portable backup format (documented in docs/backup-format.md).
//!
//! A backup is one UTF-8 JSON file holding every note, including archived and
//! trashed ones, with its window state and privacy flag. It contains no
//! settings and no PIN. Version 2 added `private` and `privateLabel`; version 1
//! files still restore, with every note not private.
//! Everything read from a backup file is validated before anything is changed.

use std::collections::HashSet;

use serde::{Deserialize, Serialize};

use crate::error::{CoreError, CoreResult};
use crate::geometry::enforce_min_size;
use crate::model::NoteWindow;
use crate::validation::{parse_content, parse_note_id, validate_color, validate_private_label};

pub const BACKUP_FORMAT: &str = "desknotes-backup";
pub const BACKUP_VERSION: u32 = 2;
/// Refuse files larger than this before parsing them.
pub const MAX_BACKUP_BYTES: usize = 200 * 1024 * 1024;
pub const MAX_BACKUP_NOTES: usize = 100_000;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Backup {
    pub format: String,
    pub version: u32,
    /// DeskNotes version that wrote the file (informational).
    #[serde(default)]
    pub app_version: String,
    /// Unix ms, UTC.
    pub exported_at: i64,
    pub notes: Vec<BackupNote>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupNote {
    pub id: String,
    /// Tiptap/ProseMirror JSON document.
    pub content: serde_json::Value,
    pub color: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub archived_at: Option<i64>,
    pub deleted_at: Option<i64>,
    #[serde(default)]
    pub edit_locked: bool,
    /// Hidden behind the privacy lock (version 2; absent in version 1 = false).
    #[serde(default)]
    pub private: bool,
    /// Neutral label shown for a locked private note (version 2; absent = "").
    #[serde(default)]
    pub private_label: String,
    pub window: NoteWindow,
}

fn invalid(msg: impl Into<String>) -> CoreError {
    CoreError::Validation(msg.into())
}

/// Parse and fully validate a backup file. Nothing is changed on failure.
pub fn parse_backup(raw: &str) -> CoreResult<Backup> {
    if raw.len() > MAX_BACKUP_BYTES {
        return Err(invalid("this backup file is too large"));
    }
    let mut backup: Backup = serde_json::from_str(raw)
        .map_err(|e| invalid(format!("this is not a DeskNotes backup file ({e})")))?;
    if backup.format != BACKUP_FORMAT {
        return Err(invalid("this is not a DeskNotes backup file"));
    }
    if backup.version > BACKUP_VERSION {
        return Err(invalid(
            "this backup was made by a newer DeskNotes; update DeskNotes to restore it",
        ));
    }
    if backup.notes.len() > MAX_BACKUP_NOTES {
        return Err(invalid("this backup holds too many notes"));
    }
    let mut seen = HashSet::new();
    for (i, note) in backup.notes.iter_mut().enumerate() {
        let n = i + 1;
        note.id = parse_note_id(&note.id).map_err(|_| invalid(format!("note {n}: invalid id")))?;
        if !seen.insert(note.id.clone()) {
            return Err(invalid(format!("note {n}: the same note appears twice")));
        }
        // Same checks as a save from the editor (size, structure, safe links).
        parse_content(&note.content.to_string()).map_err(|e| invalid(format!("note {n}: {e}")))?;
        note.color = validate_color(&note.color).map_err(|e| invalid(format!("note {n}: {e}")))?;
        note.private_label = validate_private_label(&note.private_label)
            .map_err(|e| invalid(format!("note {n}: {e}")))?;
        let times = [
            Some(note.created_at),
            Some(note.updated_at),
            note.archived_at,
            note.deleted_at,
        ];
        if times.into_iter().flatten().any(|t| t < 0) {
            return Err(invalid(format!("note {n}: invalid date")));
        }
        let w = &mut note.window;
        if [w.x, w.y].into_iter().flatten().any(|v| !v.is_finite()) {
            return Err(invalid(format!("note {n}: invalid window position")));
        }
        (w.width, w.height) = enforce_min_size(w.width, w.height);
    }
    Ok(backup)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn note(id: &str) -> serde_json::Value {
        json!({
            "id": id,
            "content": {"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Hello"}]}]},
            "color": "#FFF4A3", "createdAt": 1, "updatedAt": 2, "archivedAt": null, "deletedAt": null,
            "editLocked": false,
            "window": {"x": 10.0, "y": 20.0, "width": 300.0, "height": 280.0, "visible": true,
                       "alwaysOnTop": false, "collapsed": false}
        })
    }

    fn file(notes: Vec<serde_json::Value>) -> String {
        json!({"format": BACKUP_FORMAT, "version": 1, "appVersion": "0.1.0", "exportedAt": 3, "notes": notes})
            .to_string()
    }

    fn file_v2(notes: Vec<serde_json::Value>) -> String {
        json!({"format": BACKUP_FORMAT, "version": 2, "appVersion": "0.2.0", "exportedAt": 3, "notes": notes})
            .to_string()
    }

    const A: &str = "2f1c8f0e-6a8b-4c51-9d4e-2b8f5f1a9c3d";
    const B: &str = "3a2d9e1f-7b9c-4d62-8e5f-3c9a6b2b0d4e";

    #[test]
    fn valid_backup_is_accepted_and_normalised() {
        let b = parse_backup(&file(vec![note(A), note(B)])).unwrap();
        assert_eq!(b.notes.len(), 2);
        assert_eq!(b.notes[0].color, "#fff4a3");
    }

    #[test]
    fn version_1_file_is_read_with_no_private_notes() {
        let b = parse_backup(&file(vec![note(A)])).unwrap();
        assert_eq!(b.version, 1);
        assert!(!b.notes[0].private);
        assert_eq!(b.notes[0].private_label, "");
    }

    #[test]
    fn version_2_keeps_private_flag_and_label() {
        let mut private = note(A);
        private["private"] = json!(true);
        private["privateLabel"] = json!("  Bank ");
        let b = parse_backup(&file_v2(vec![private, note(B)])).unwrap();
        assert!(b.notes[0].private);
        assert_eq!(b.notes[0].private_label, "Bank", "label is normalised");
        assert!(!b.notes[1].private, "the fields are optional");

        let mut long = note(A);
        long["privateLabel"] = json!("x".repeat(41));
        assert!(parse_backup(&file_v2(vec![long])).is_err());
        let mut control = note(A);
        control["privateLabel"] = json!("a\u{7}b");
        assert!(parse_backup(&file_v2(vec![control])).is_err());
    }

    #[test]
    fn written_backups_name_the_new_fields() {
        let b = parse_backup(&file_v2(vec![note(A)])).unwrap();
        let out = serde_json::to_value(&b).unwrap();
        assert_eq!(out["notes"][0]["private"], json!(false));
        assert_eq!(out["notes"][0]["privateLabel"], json!(""));
    }

    #[test]
    fn wrong_files_are_refused() {
        assert!(parse_backup("not json").is_err());
        assert!(
            parse_backup(r#"{"format":"other","version":1,"exportedAt":1,"notes":[]}"#).is_err()
        );
        let newer = file(vec![]).replace("\"version\":1", "\"version\":99");
        assert!(
            parse_backup(&newer)
                .unwrap_err()
                .to_string()
                .contains("newer DeskNotes")
        );
    }

    #[test]
    fn every_note_is_validated() {
        let mut bad_link = note(A);
        bad_link["content"] = json!({"type":"doc","content":[{"type":"paragraph","content":[
            {"type":"text","text":"x","marks":[{"type":"link","attrs":{"href":"javascript:alert(1)"}}]}]}]});
        assert!(parse_backup(&file(vec![bad_link])).is_err());

        let mut bad_id = note(A);
        bad_id["id"] = json!("../../etc");
        assert!(parse_backup(&file(vec![bad_id])).is_err());

        assert!(
            parse_backup(&file(vec![note(A), note(A)]))
                .unwrap_err()
                .to_string()
                .contains("twice")
        );

        let mut bad_color = note(A);
        bad_color["color"] = json!("red");
        assert!(parse_backup(&file(vec![bad_color])).is_err());

        // JSON cannot hold infinities; a non-number position is refused while parsing.
        let mut bad_pos = note(A);
        bad_pos["window"]["x"] = json!("far away");
        assert!(parse_backup(&file(vec![bad_pos])).is_err());
    }
}
