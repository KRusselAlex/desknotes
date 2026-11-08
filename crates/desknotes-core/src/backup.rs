//! Portable backup format (documented in docs/backup-format.md).
//!
//! A backup is one UTF-8 JSON file holding every note, including archived and
//! trashed ones, with its window state and privacy flag. It contains no
//! settings and no PIN. Version 6 added `images` (the pictures notes use, as base64).
//! Version 5 added `completedAt` (when a note was marked done); version 4
//! added `reminder` (a note's reminder); version 3
//! added `appearance` (per-note text and window styling); version 2 added
//! `private` and `privateLabel`. Older files still restore, with every note not
//! private, default appearance, no reminder and not done.
//! Everything read from a backup file is validated before anything is changed.

use std::collections::HashSet;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use serde::{Deserialize, Serialize};

use crate::error::{CoreError, CoreResult};
use crate::geometry::enforce_min_size;
use crate::image_prep::{PrepLimits, image_id, sniff_mime};
use crate::model::{Appearance, NoteWindow};
use crate::now_ms;
use crate::reminders::{validate_rule, within_range};
use crate::validation::{
    is_image_id, parse_content, parse_note_id, validate_appearance, validate_color,
    validate_private_label,
};

pub const BACKUP_FORMAT: &str = "desknotes-backup";
pub const BACKUP_VERSION: u32 = 6;
/// Refuse files larger than this before parsing them.
pub const MAX_BACKUP_BYTES: usize = 300 * 1024 * 1024;
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
    /// The images the notes use (version 6; absent in older files = none).
    #[serde(default)]
    pub images: Vec<BackupImage>,
}

/// An image as written to a backup: the stored bytes, unchanged, as standard base64.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BackupImage {
    /// 64 lowercase hex characters: the SHA-256 of the decoded bytes.
    pub id: String,
    /// `image/png`, `image/jpeg`, `image/gif` or `image/webp`.
    pub mime: String,
    pub width: u32,
    pub height: u32,
    /// Standard base64 (with padding) of the stored bytes.
    pub data: String,
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
    /// When the note was marked done (version 5; absent or null = not done).
    #[serde(default)]
    pub completed_at: Option<i64>,
    #[serde(default)]
    pub edit_locked: bool,
    /// Hidden behind the privacy lock (version 2; absent in version 1 = false).
    #[serde(default)]
    pub private: bool,
    /// Neutral label shown for a locked private note (version 2; absent = "").
    #[serde(default)]
    pub private_label: String,
    /// Text and window styling (version 3; absent in older files = defaults).
    #[serde(default)]
    pub appearance: Appearance,
    /// The note's reminder (version 4; absent or null = none).
    #[serde(default)]
    pub reminder: Option<BackupReminder>,
    pub window: NoteWindow,
}

/// A reminder as written to a backup. `due_at`, `snoozed_until` and `fired_at` are
/// Unix ms (UTC); the date, time and repeat are the user's local wall-clock choice.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BackupReminder {
    /// `YYYY-MM-DD`.
    pub local_date: String,
    /// `HH:MM`, 24 h.
    pub local_time: String,
    /// `none`, `daily`, `weekdays`, `weekly` or `monthly`.
    pub repeat: String,
    pub due_at: i64,
    #[serde(default)]
    pub snoozed_until: Option<i64>,
    #[serde(default)]
    pub fired_at: Option<i64>,
}

fn invalid(msg: impl Into<String>) -> CoreError {
    CoreError::Validation(msg.into())
}

/// Same checks as setting a reminder: a real date and time, a known repeat, and every
/// instant within 100 years of now.
fn validate_backup_reminder(r: &BackupReminder) -> CoreResult<()> {
    validate_rule(&r.local_date, &r.local_time, &r.repeat)?;
    let now = now_ms();
    let all_in_range = [Some(r.due_at), r.snoozed_until, r.fired_at]
        .into_iter()
        .flatten()
        .all(|t| t >= 0 && within_range(t, now));
    if all_in_range {
        Ok(())
    } else {
        Err(invalid("invalid reminder time"))
    }
}

/// The image types DeskNotes stores.
const IMAGE_MIMES: [&str; 4] = ["image/png", "image/jpeg", "image/gif", "image/webp"];
/// The widest or tallest an image can be (a GIF's own limit). Sizes are only recorded.
const MAX_IMAGE_SIDE: u32 = 65_535;

/// The bytes of a backup image, after the checks that make them safe to store. Nothing
/// is re-encoded, so the id (the SHA-256 of the bytes) stays the same as when written.
pub(crate) fn decode_backup_image(img: &BackupImage) -> CoreResult<Vec<u8>> {
    if !is_image_id(&img.id) {
        return Err(invalid("the id is not 64 lowercase hex characters"));
    }
    if !IMAGE_MIMES.contains(&img.mime.as_str()) {
        return Err(invalid("the type is not PNG, JPEG, GIF or WebP"));
    }
    if [img.width, img.height]
        .into_iter()
        .any(|side| side == 0 || side > MAX_IMAGE_SIDE)
    {
        return Err(invalid("the size is not valid"));
    }
    let max = PrepLimits::DEFAULT.max_output;
    // Base64 is 4 characters per 3 bytes: refuse before decoding something huge.
    if img.data.len() > max.div_ceil(3) * 4 {
        return Err(invalid("the image is too large"));
    }
    let bytes = STANDARD
        .decode(&img.data)
        .map_err(|_| invalid("the data is not valid base64"))?;
    if bytes.len() > max {
        return Err(invalid("the image is too large"));
    }
    if sniff_mime(&bytes) != Some(img.mime.as_str()) {
        return Err(invalid("the data is not an image of the stated type"));
    }
    if image_id(&bytes) != img.id {
        return Err(invalid("the id does not match the image"));
    }
    Ok(bytes)
}

/// Read each note's appearance on its own, so a key this version does not know
/// names the note it is in (read with the whole file, it would only give a line
/// and column).
fn check_appearances(file: &serde_json::Value) -> CoreResult<()> {
    let notes = file.get("notes").and_then(serde_json::Value::as_array);
    for (i, note) in notes.into_iter().flatten().enumerate() {
        if let Some(appearance) = note.get("appearance") {
            Appearance::deserialize(appearance)
                .map_err(|e| invalid(format!("note {}: appearance: {e}", i + 1)))?;
        }
    }
    Ok(())
}

/// Parse and fully validate a backup file. Nothing is changed on failure.
pub fn parse_backup(raw: &str) -> CoreResult<Backup> {
    if raw.len() > MAX_BACKUP_BYTES {
        return Err(invalid("this backup file is too large"));
    }
    let value: serde_json::Value = serde_json::from_str(raw)
        .map_err(|e| invalid(format!("this is not a DeskNotes backup file ({e})")))?;
    check_appearances(&value)?;
    let mut backup: Backup = serde_json::from_value(value)
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
        note.appearance = validate_appearance(std::mem::take(&mut note.appearance))
            .map_err(|e| invalid(format!("note {n}: {e}")))?;
        if let Some(r) = &note.reminder {
            validate_backup_reminder(r).map_err(|e| invalid(format!("note {n}: {e}")))?;
        }
        let times = [
            Some(note.created_at),
            Some(note.updated_at),
            note.archived_at,
            note.deleted_at,
            note.completed_at,
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
    let mut seen_images = HashSet::new();
    for (i, img) in backup.images.iter().enumerate() {
        let n = i + 1;
        decode_backup_image(img).map_err(|e| invalid(format!("image {n}: {e}")))?;
        if !seen_images.insert(img.id.as_str()) {
            return Err(invalid(format!("image {n}: the same image appears twice")));
        }
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
    fn a_label_with_hidden_characters_still_restores_without_them() {
        // Removed like in any label (DES-30), so a backup made before the rule restores.
        let mut private = note(A);
        private["private"] = json!(true);
        private["privateLabel"] = json!("\u{200B}Ba\u{00AD}nk");
        let b = parse_backup(&file_v2(vec![private])).unwrap();
        assert_eq!(b.notes[0].private_label, "Bank");
    }

    fn file_v3(notes: Vec<serde_json::Value>) -> String {
        json!({"format": BACKUP_FORMAT, "version": 3, "appVersion": "0.3.0", "exportedAt": 3, "notes": notes})
            .to_string()
    }

    #[test]
    fn version_2_file_restores_default_appearance() {
        let mut private = note(A);
        private["private"] = json!(true);
        for raw in [file(vec![note(A)]), file_v2(vec![private])] {
            let b = parse_backup(&raw).unwrap();
            assert_eq!(b.notes[0].appearance, Appearance::default());
        }
    }

    #[test]
    fn version_3_keeps_and_normalises_appearance() {
        let mut styled = note(A);
        styled["appearance"] = json!({"fontSize": 18, "textColor": "#1D4F91", "direction": "rtl"});
        let b = parse_backup(&file_v3(vec![styled, note(B)])).unwrap();
        assert_eq!(b.notes[0].appearance.font_size, Some(18));
        assert_eq!(
            b.notes[0].appearance.text_color.as_deref(),
            Some("#1d4f91"),
            "colour is normalised"
        );
        assert_eq!(b.notes[1].appearance, Appearance::default());
        let out = serde_json::to_value(&b).unwrap();
        assert_eq!(out["notes"][1]["appearance"], json!({}));
    }

    #[test]
    fn backup_refuses_invalid_appearance() {
        let mut bad = note(A);
        bad["appearance"] = json!({"fontSize": 99});
        let err = parse_backup(&file_v3(vec![note(B), bad])).unwrap_err();
        assert!(err.to_string().contains("note 2"), "names the note: {err}");

        let mut unknown = note(A);
        unknown["appearance"] = json!({"css": "x"});
        let err = parse_backup(&file_v3(vec![note(B), unknown])).unwrap_err();
        assert!(err.to_string().contains("unknown field"), "{err}");
        assert!(err.to_string().contains("note 2"), "names the note: {err}");
    }

    fn file_v4(notes: Vec<serde_json::Value>) -> String {
        json!({"format": BACKUP_FORMAT, "version": 4, "appVersion": "0.4.0", "exportedAt": 3, "notes": notes})
            .to_string()
    }

    fn reminder() -> serde_json::Value {
        let due = now_ms() + 86_400_000;
        json!({"localDate": "2026-11-04", "localTime": "14:00", "repeat": "weekly",
               "dueAt": due, "snoozedUntil": due + 600_000, "firedAt": due})
    }

    #[test]
    fn version_4_keeps_reminders_and_older_files_have_none() {
        let mut with = note(A);
        with["reminder"] = reminder();
        let b = parse_backup(&file_v4(vec![with, note(B)])).unwrap();
        let r = b.notes[0].reminder.as_ref().unwrap();
        assert_eq!(
            (r.local_date.as_str(), r.local_time.as_str()),
            ("2026-11-04", "14:00")
        );
        assert_eq!(r.repeat, "weekly");
        assert!(r.snoozed_until.is_some() && r.fired_at.is_some());
        assert_eq!(b.notes[1].reminder, None, "the field is optional");
        let out = serde_json::to_value(&b).unwrap();
        assert_eq!(out["notes"][1]["reminder"], json!(null));
        assert_eq!(out["notes"][0]["reminder"]["localTime"], json!("14:00"));

        for raw in [
            file(vec![note(A)]),
            file_v2(vec![note(A)]),
            file_v3(vec![note(A)]),
        ] {
            assert_eq!(parse_backup(&raw).unwrap().notes[0].reminder, None);
        }
    }

    #[test]
    fn backup_refuses_an_invalid_reminder_and_names_the_note() {
        let due = now_ms() + 1000;
        let bad = [
            json!({"localDate": "2026-02-30", "localTime": "14:00", "repeat": "none", "dueAt": due}),
            json!({"localDate": "2026-11-04", "localTime": "24:00", "repeat": "none", "dueAt": due}),
            json!({"localDate": "2026-11-04", "localTime": "14:00", "repeat": "hourly", "dueAt": due}),
            json!({"localDate": "2026-11-04", "localTime": "14:00", "repeat": "none", "dueAt": -1}),
            json!({"localDate": "2026-11-04", "localTime": "14:00", "repeat": "none", "dueAt": 10_000_000_000_000_i64}),
            json!({"localDate": "2026-11-04", "localTime": "14:00", "repeat": "none", "dueAt": i64::MAX}),
            json!({"localDate": "2026-11-04", "localTime": "14:00", "repeat": "none", "dueAt": due, "firedAt": -5}),
            json!({"localDate": "2026-11-04", "localTime": "14:00", "repeat": "none", "dueAt": due, "snoozedUntil": i64::MIN}),
            json!({"localDate": "2026-11-04", "localTime": "14:00", "repeat": "none", "dueAt": due, "css": 1}),
            json!({"localDate": "2026-11-04", "localTime": "14:00", "repeat": "none"}),
        ];
        for r in bad {
            let mut n = note(B);
            n["reminder"] = r.clone();
            let text = parse_backup(&file_v4(vec![note(A), n]))
                .unwrap_err()
                .to_string();
            // Unknown keys and a missing `dueAt` fail while the JSON is read; every
            // other case is refused by validation, which names the note.
            let at_parse = r.get("css").is_some() || r.get("dueAt").is_none();
            if at_parse {
                assert!(
                    text.contains("unknown field") || text.contains("missing field"),
                    "{r}: {text}"
                );
            } else {
                assert!(text.contains("note 2"), "{r}: {text}");
            }
        }
    }

    fn file_v5(notes: Vec<serde_json::Value>) -> String {
        json!({"format": BACKUP_FORMAT, "version": 5, "appVersion": "0.5.0", "exportedAt": 3, "notes": notes})
            .to_string()
    }

    #[test]
    fn version_5_keeps_the_done_date_and_older_files_have_none() {
        let mut done = note(A);
        done["completedAt"] = json!(1_700_000_000_000_i64);
        let b = parse_backup(&file_v5(vec![done, note(B)])).unwrap();
        assert_eq!(b.notes[0].completed_at, Some(1_700_000_000_000));
        assert_eq!(b.notes[1].completed_at, None, "the field is optional");
        let out = serde_json::to_value(&b).unwrap();
        assert_eq!(out["notes"][0]["completedAt"], json!(1_700_000_000_000_i64));
        assert_eq!(out["notes"][1]["completedAt"], json!(null));
        for raw in [
            file(vec![note(A)]),
            file_v2(vec![note(A)]),
            file_v3(vec![note(A)]),
            file_v4(vec![note(A)]),
        ] {
            assert_eq!(parse_backup(&raw).unwrap().notes[0].completed_at, None);
        }
    }

    #[test]
    fn backup_refuses_a_negative_done_date_and_names_the_note() {
        let mut bad = note(B);
        bad["completedAt"] = json!(-1);
        let err = parse_backup(&file_v5(vec![note(A), bad])).unwrap_err();
        assert!(err.to_string().contains("note 2"), "{err}");
    }

    #[test]
    fn written_backups_name_the_new_fields() {
        let b = parse_backup(&file_v2(vec![note(A)])).unwrap();
        let out = serde_json::to_value(&b).unwrap();
        assert_eq!(out["notes"][0]["private"], json!(false));
        assert_eq!(out["notes"][0]["privateLabel"], json!(""));
        assert_eq!(out["notes"][0]["appearance"], json!({}));
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
