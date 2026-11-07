use rusqlite::OptionalExtension;

use super::Database;
use crate::error::{CoreError, CoreResult};
use crate::model::{
    AppAppearance, DEFAULT_COLOR, Layout, MAX_DEFAULT_SIZE, MAX_MIN_NOTE_SIDE, MIN_DEFAULT_SIZE,
    NoteSize,
};
use crate::validation::{parse_note_id, validate_color, validate_font_name};

/// Settings keys. Values are stored as text.
pub const NEW_NOTE_COLOR: &str = "new_note_color";
/// JSON list of note ids hidden by "Hide all notes", for "Show hidden notes".
pub const HIDDEN_BY_HIDE_ALL: &str = "hidden_by_hide_all";
/// JSON `{"width": .., "height": ..}`: the smallest size a note window may take.
pub const MIN_NOTE_SIZE: &str = "min_note_size";
/// `"true"` or `"false"`: black-on-white notes.
pub const APPEARANCE_HIGH_CONTRAST: &str = "appearance_high_contrast";
/// `"comfortable"` or `"compact"`.
pub const APPEARANCE_LAYOUT: &str = "appearance_layout";
/// A font name, or empty for the system default.
pub const APPEARANCE_DEFAULT_FONT: &str = "appearance_default_font";
/// Default text size in px as a decimal string, `"10"`–`"32"`.
pub const APPEARANCE_DEFAULT_SIZE: &str = "appearance_default_size";
/// `"1"` once the welcome note has been created on a new database (DES-29).
pub const FIRST_RUN_DONE: &str = "first_run_done";

/// Automation rules (DES-42). The four switches hold `"1"` or are absent.
pub const AUTO_COMPLETE_CHECKLISTS: &str = "auto_complete_checklists";
pub const RESET_CHECKLISTS_ON_REPEAT: &str = "reset_checklists_on_repeat";
pub const ARCHIVE_DONE_ENABLED: &str = "archive_done_enabled";
pub const PURGE_TRASH_ENABLED: &str = "purge_trash_enabled";
/// Days as decimal strings. Kept while the rule is off, so turning it back on restores it.
pub const ARCHIVE_DONE_DAYS: &str = "archive_done_days";
pub const PURGE_TRASH_DAYS: &str = "purge_trash_days";
/// `"1"` when a restore switched "Empty old trash" off; absent otherwise.
pub const PURGE_TRASH_OFF_BY_RESTORE: &str = "purge_trash_off_by_restore";

impl Database {
    pub fn get_setting(&self, key: &str) -> CoreResult<Option<String>> {
        Ok(self
            .conn
            .query_row("SELECT value FROM settings WHERE key = ?1", [key], |r| {
                r.get(0)
            })
            .optional()?)
    }

    pub fn set_setting(&self, key: &str, value: &str) -> CoreResult<()> {
        self.conn.execute(
            "INSERT INTO settings (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            [key, value],
        )?;
        Ok(())
    }
}

impl Database {
    /// Colour for new notes: the saved preference, or the default if it is
    /// missing or invalid (an invalid stored value is never used).
    pub fn new_note_color(&self) -> CoreResult<String> {
        Ok(self
            .get_setting(NEW_NOTE_COLOR)?
            .and_then(|c| validate_color(&c).ok())
            .unwrap_or_else(|| DEFAULT_COLOR.to_string()))
    }

    pub fn set_new_note_color(&self, color: &str) -> CoreResult<()> {
        let color = validate_color(color)?;
        self.set_setting(NEW_NOTE_COLOR, &color)
    }

    /// Smallest size a note window may take: the saved preference, or the floor
    /// if it is missing or invalid (an invalid stored value is never used).
    pub fn min_note_size(&self) -> CoreResult<NoteSize> {
        Ok(self
            .get_setting(MIN_NOTE_SIZE)?
            .and_then(|raw| serde_json::from_str::<NoteSize>(&raw).ok())
            .filter(NoteSize::is_valid_minimum)
            .unwrap_or(NoteSize::FLOOR))
    }

    pub fn set_min_note_size(&self, width: u32, height: u32) -> CoreResult<NoteSize> {
        let size = NoteSize { width, height };
        if !size.is_valid_minimum() {
            return Err(CoreError::Validation(format!(
                "minimum note size must be {}–{MAX_MIN_NOTE_SIDE} × {}–{MAX_MIN_NOTE_SIDE} px",
                NoteSize::FLOOR.width,
                NoteSize::FLOOR.height,
            )));
        }
        let json =
            serde_json::to_string(&size).map_err(|e| CoreError::Validation(e.to_string()))?;
        self.set_setting(MIN_NOTE_SIZE, &json)?;
        Ok(size)
    }

    /// App-wide note appearance. Each field falls back to its default on its
    /// own when missing or invalid; a bad stored value never fails the read.
    pub fn app_appearance(&self) -> CoreResult<AppAppearance> {
        let defaults = AppAppearance::default();
        let high_contrast = match self.get_setting(APPEARANCE_HIGH_CONTRAST)?.as_deref() {
            Some("true") => true,
            Some("false") => false,
            _ => defaults.high_contrast,
        };
        let layout = match self.get_setting(APPEARANCE_LAYOUT)?.as_deref() {
            Some("comfortable") => Layout::Comfortable,
            Some("compact") => Layout::Compact,
            _ => defaults.layout,
        };
        let default_font = self
            .get_setting(APPEARANCE_DEFAULT_FONT)?
            .and_then(|raw| validate_font_name(&raw).ok())
            .unwrap_or(defaults.default_font);
        let default_size = self
            .get_setting(APPEARANCE_DEFAULT_SIZE)?
            .and_then(|raw| raw.parse::<u8>().ok())
            .filter(|s| (MIN_DEFAULT_SIZE..=MAX_DEFAULT_SIZE).contains(s))
            .unwrap_or(defaults.default_size);
        Ok(AppAppearance {
            high_contrast,
            layout,
            default_font,
            default_size,
        })
    }

    /// Validate and store all four appearance settings in one transaction, and
    /// return the normalised value (font trimmed, blank meaning none).
    pub fn set_app_appearance(&self, a: AppAppearance) -> CoreResult<AppAppearance> {
        if !(MIN_DEFAULT_SIZE..=MAX_DEFAULT_SIZE).contains(&a.default_size) {
            return Err(CoreError::Validation(format!(
                "default text size must be {MIN_DEFAULT_SIZE}–{MAX_DEFAULT_SIZE} px"
            )));
        }
        let default_font = match a.default_font.as_deref() {
            Some(font) => validate_font_name(font)?,
            None => None,
        };
        let a = AppAppearance { default_font, ..a };
        let layout = match a.layout {
            Layout::Comfortable => "comfortable",
            Layout::Compact => "compact",
        };
        let tx = self.conn.unchecked_transaction()?;
        for (key, value) in [
            (
                APPEARANCE_HIGH_CONTRAST,
                if a.high_contrast { "true" } else { "false" }.to_string(),
            ),
            (APPEARANCE_LAYOUT, layout.to_string()),
            (
                APPEARANCE_DEFAULT_FONT,
                a.default_font.clone().unwrap_or_default(),
            ),
            (APPEARANCE_DEFAULT_SIZE, a.default_size.to_string()),
        ] {
            tx.execute(
                "INSERT INTO settings (key, value) VALUES (?1, ?2)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                [key, value.as_str()],
            )?;
        }
        tx.commit()?;
        Ok(a)
    }

    /// Notes hidden by the last "Hide all notes". Invalid entries are ignored.
    pub fn hidden_by_hide_all(&self) -> CoreResult<Vec<String>> {
        let ids: Vec<String> = self
            .get_setting(HIDDEN_BY_HIDE_ALL)?
            .and_then(|raw| serde_json::from_str(&raw).ok())
            .unwrap_or_default();
        Ok(ids
            .into_iter()
            .filter_map(|id| parse_note_id(&id).ok())
            .collect())
    }

    pub fn set_hidden_by_hide_all(&self, ids: &[String]) -> CoreResult<()> {
        let ids: Vec<String> = ids
            .iter()
            .map(|id| parse_note_id(id))
            .collect::<CoreResult<_>>()?;
        let json = serde_json::to_string(&ids)
            .map_err(|e| crate::error::CoreError::Validation(e.to_string()))?;
        self.set_setting(HIDDEN_BY_HIDE_ALL, &json)
    }
}

#[cfg(test)]
mod tests {
    use crate::{AppAppearance, Database, Layout, NoteSize};

    #[test]
    fn settings_round_trip() {
        let db = Database::open_in_memory().unwrap();
        assert_eq!(db.get_setting("theme").unwrap(), None);
        db.set_setting("theme", "light").unwrap();
        db.set_setting("theme", "dark").unwrap();
        assert_eq!(db.get_setting("theme").unwrap().as_deref(), Some("dark"));
    }

    #[test]
    fn hide_all_list_round_trips_and_ignores_bad_entries() {
        let db = Database::open_in_memory().unwrap();
        assert!(db.hidden_by_hide_all().unwrap().is_empty());
        let a = db.create_note(None).unwrap().id;
        db.set_hidden_by_hide_all(std::slice::from_ref(&a)).unwrap();
        assert_eq!(db.hidden_by_hide_all().unwrap(), vec![a.clone()]);
        assert!(db.set_hidden_by_hide_all(&["../x".into()]).is_err());
        db.set_setting(super::HIDDEN_BY_HIDE_ALL, &format!("[\"{a}\", \"junk\"]"))
            .unwrap();
        assert_eq!(db.hidden_by_hide_all().unwrap(), vec![a]);
        db.set_setting(super::HIDDEN_BY_HIDE_ALL, "not json")
            .unwrap();
        assert!(db.hidden_by_hide_all().unwrap().is_empty());
    }

    #[test]
    fn min_note_size_defaults_to_the_floor_and_round_trips() {
        let db = Database::open_in_memory().unwrap();
        let floor = NoteSize {
            width: 180,
            height: 120,
        };
        assert_eq!(db.min_note_size().unwrap(), floor);
        assert_eq!(
            db.set_min_note_size(240, 200).unwrap(),
            NoteSize {
                width: 240,
                height: 200
            }
        );
        assert_eq!(
            db.min_note_size().unwrap(),
            NoteSize {
                width: 240,
                height: 200
            }
        );
        // Both bounds are allowed.
        db.set_min_note_size(180, 120).unwrap();
        db.set_min_note_size(600, 600).unwrap();
    }

    #[test]
    fn min_note_size_refuses_out_of_range_values() {
        let db = Database::open_in_memory().unwrap();
        db.set_min_note_size(240, 200).unwrap();
        for (w, h) in [(179, 120), (180, 119), (601, 200), (240, 601), (0, 0)] {
            assert_eq!(
                db.set_min_note_size(w, h).unwrap_err().code(),
                "validation",
                "{w}x{h}"
            );
        }
        // A refused value leaves the saved one untouched.
        assert_eq!(
            db.min_note_size().unwrap(),
            NoteSize {
                width: 240,
                height: 200
            }
        );
    }

    #[test]
    fn a_damaged_min_note_size_falls_back_to_the_floor() {
        let db = Database::open_in_memory().unwrap();
        for raw in ["not json", r#"{"width":5,"height":5}"#, r#"{"width":"x"}"#] {
            db.set_setting(super::MIN_NOTE_SIZE, raw).unwrap();
            assert_eq!(
                db.min_note_size().unwrap(),
                NoteSize {
                    width: 180,
                    height: 120
                },
                "{raw}"
            );
        }
    }

    #[test]
    fn new_note_color_is_validated_and_has_a_default() {
        let db = Database::open_in_memory().unwrap();
        assert_eq!(db.new_note_color().unwrap(), crate::DEFAULT_COLOR);
        db.set_new_note_color("#C8F7C5").unwrap();
        assert_eq!(db.new_note_color().unwrap(), "#c8f7c5");
        assert!(db.set_new_note_color("green").is_err());
        db.set_setting(super::NEW_NOTE_COLOR, "not-a-colour")
            .unwrap();
        assert_eq!(db.new_note_color().unwrap(), crate::DEFAULT_COLOR);
    }

    #[test]
    fn app_appearance_defaults_when_unset() {
        let db = Database::open_in_memory().unwrap();
        let a = db.app_appearance().unwrap();
        assert_eq!(a, AppAppearance::default());
        assert!(!a.high_contrast);
        assert_eq!(a.layout, Layout::Comfortable);
        assert_eq!(a.default_font, None);
        assert_eq!(a.default_size, 15);
    }

    #[test]
    fn set_and_read_back() {
        let db = Database::open_in_memory().unwrap();
        let want = AppAppearance {
            high_contrast: true,
            layout: Layout::Compact,
            default_font: Some("Amiri".into()),
            default_size: 18,
        };
        assert_eq!(db.set_app_appearance(want.clone()).unwrap(), want);
        assert_eq!(db.app_appearance().unwrap(), want);
        assert_eq!(
            db.get_setting(super::APPEARANCE_DEFAULT_SIZE)
                .unwrap()
                .as_deref(),
            Some("18")
        );
    }

    #[test]
    fn set_refuses_out_of_range_size() {
        let db = Database::open_in_memory().unwrap();
        for size in [9, 33] {
            let a = AppAppearance {
                default_size: size,
                ..AppAppearance::default()
            };
            assert_eq!(
                db.set_app_appearance(a).unwrap_err().code(),
                "validation",
                "{size}"
            );
        }
        for size in [10, 32] {
            let a = AppAppearance {
                default_size: size,
                ..AppAppearance::default()
            };
            db.set_app_appearance(a).unwrap();
        }
    }

    #[test]
    fn set_refuses_unsafe_font_and_stores_nothing() {
        let db = Database::open_in_memory().unwrap();
        let a = AppAppearance {
            high_contrast: true,
            default_font: Some("a;b".into()),
            ..AppAppearance::default()
        };
        assert_eq!(db.set_app_appearance(a).unwrap_err().code(), "validation");
        assert_eq!(db.app_appearance().unwrap(), AppAppearance::default());
        assert_eq!(
            db.get_setting(super::APPEARANCE_HIGH_CONTRAST).unwrap(),
            None
        );
    }

    #[test]
    fn blank_font_means_system_default() {
        let db = Database::open_in_memory().unwrap();
        let a = AppAppearance {
            default_font: Some("  ".into()),
            ..AppAppearance::default()
        };
        assert_eq!(db.set_app_appearance(a).unwrap().default_font, None);
        assert_eq!(db.app_appearance().unwrap().default_font, None);
        // A padded name is trimmed.
        let a = AppAppearance {
            default_font: Some("  Amiri ".into()),
            ..AppAppearance::default()
        };
        assert_eq!(
            db.set_app_appearance(a).unwrap().default_font.as_deref(),
            Some("Amiri")
        );
    }

    #[test]
    fn invalid_stored_values_read_as_defaults() {
        let db = Database::open_in_memory().unwrap();
        db.set_setting(super::APPEARANCE_DEFAULT_SIZE, "99")
            .unwrap();
        db.set_setting(super::APPEARANCE_HIGH_CONTRAST, "maybe")
            .unwrap();
        db.set_setting(super::APPEARANCE_LAYOUT, "wide").unwrap();
        db.set_setting(super::APPEARANCE_DEFAULT_FONT, "a;b")
            .unwrap();
        assert_eq!(db.app_appearance().unwrap(), AppAppearance::default());

        // Each field falls back on its own: valid neighbours are kept.
        db.set_setting(super::APPEARANCE_HIGH_CONTRAST, "true")
            .unwrap();
        db.set_setting(super::APPEARANCE_DEFAULT_SIZE, "20")
            .unwrap();
        let a = db.app_appearance().unwrap();
        assert!(a.high_contrast);
        assert_eq!(a.default_size, 20);
        assert_eq!(a.layout, Layout::Comfortable);
        assert_eq!(a.default_font, None);
        db.set_setting(super::APPEARANCE_DEFAULT_SIZE, "abc")
            .unwrap();
        assert_eq!(db.app_appearance().unwrap().default_size, 15);
    }

    #[test]
    fn app_appearance_serialises_camel_case() {
        let json = serde_json::to_value(AppAppearance {
            high_contrast: true,
            layout: Layout::Compact,
            default_font: None,
            default_size: 15,
        })
        .unwrap();
        assert_eq!(
            json,
            serde_json::json!({
                "highContrast": true,
                "layout": "compact",
                "defaultFont": null,
                "defaultSize": 15
            })
        );
    }
}
