use rusqlite::OptionalExtension;

use super::Database;
use crate::error::CoreResult;
use crate::model::DEFAULT_COLOR;
use crate::validation::{parse_note_id, validate_color};

/// Settings keys. Values are stored as text.
pub const NEW_NOTE_COLOR: &str = "new_note_color";
/// JSON list of note ids hidden by "Hide all notes", for "Show hidden notes".
pub const HIDDEN_BY_HIDE_ALL: &str = "hidden_by_hide_all";

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
    use crate::Database;

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
}
