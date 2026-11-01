use rusqlite::OptionalExtension;

use super::Database;
use crate::error::CoreResult;
use crate::model::DEFAULT_COLOR;
use crate::validation::validate_color;

/// Settings keys. Values are stored as text.
pub const NEW_NOTE_COLOR: &str = "new_note_color";

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
