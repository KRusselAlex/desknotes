//! `desknotes --reset-pin` (design D11): the last resort when neither the Ubuntu
//! password nor the recovery code can replace a forgotten PIN. Runs before
//! Tauri starts and opens no window. Only with DeskNotes closed; where the
//! Ubuntu password can be used it is asked first, so this never weakens D5.
//! Otherwise it resets, and the next start shows "The PIN was reset on <date>"
//! until acknowledged. Prints what happened; no PIN, code or note text.

use std::ffi::OsString;
use std::path::PathBuf;

use desknotes_core::{CoreError, Database, now_ms};

use crate::platform::system_auth::{ask_system_password, system_auth_available};
use crate::platform::{single_instance, user_data_dir};
use crate::state::{BACKUP_DIR, DB_FILE, startup_message};

pub const RESET_PIN_ARG: &str = "--reset-pin";

/// `identifier` in `tauri.conf.json`: Tauri's data folder name and the
/// single-instance bus name are made from it.
pub const APP_IDENTIFIER: &str = "io.github.krusselalex.desknotes";

const NOTHING_CHANGED: &str = "Nothing was changed.";

/// The message when the notes database cannot be opened. A database from a
/// newer DeskNotes gets the same plain message as at start-up, which already
/// says nothing was changed; every other failure keeps this command's wording.
fn open_error(e: &CoreError) -> String {
    match e {
        CoreError::SchemaTooNew { .. } => startup_message(e),
        other => format!("The notes database could not be opened: {other}. {NOTHING_CHANGED}"),
    }
}

/// Whether the command line asks for the reset (the program name is skipped).
pub fn requested(args: impl IntoIterator<Item = OsString>) -> bool {
    args.into_iter().skip(1).any(|a| a == RESET_PIN_ARG)
}

/// Run the reset and return the process exit code: 0 done (or nothing to
/// reset), 1 refused or failed.
pub fn run() -> i32 {
    match reset() {
        Ok(done) => {
            println!("{done}");
            0
        }
        Err(why) => {
            eprintln!("desknotes {RESET_PIN_ARG}: {why}");
            1
        }
    }
}

fn running_message() -> String {
    format!(
        "DeskNotes is running. Quit it first (tray icon → Quit DeskNotes), then run \
         desknotes {RESET_PIN_ARG} again. {NOTHING_CHANGED}"
    )
}

fn database_path() -> Result<(PathBuf, PathBuf), String> {
    let dir = user_data_dir()
        .ok_or_else(|| format!("No data folder was found for this user. {NOTHING_CHANGED}"))?
        .join(APP_IDENTIFIER);
    Ok((dir.join(DB_FILE), dir.join(BACKUP_DIR)))
}

fn reset() -> Result<String, String> {
    // Hold DeskNotes' single-instance name from the start, so it cannot start
    // while the database is opened (which may migrate it), the password is
    // asked for or the reset is written. A running DeskNotes owns it already.
    let _claim = match single_instance::claim(APP_IDENTIFIER) {
        Ok(Some(claim)) => claim,
        Ok(None) => return Err(running_message()),
        Err(e) => {
            return Err(format!(
                "Could not check whether DeskNotes is running ({e}). {NOTHING_CHANGED}"
            ));
        }
    };

    let (db_path, backup_dir) = database_path()?;
    // Opening would create an empty database; there is nothing to reset then.
    if !db_path.is_file() {
        return Err(format!(
            "No DeskNotes notes were found at {}. {NOTHING_CHANGED}",
            db_path.display()
        ));
    }
    let db = Database::open(&db_path, &backup_dir).map_err(|e| open_error(&e))?;
    let pin_set = db
        .pin_is_set()
        .map_err(|e| format!("The PIN setting could not be read: {e}. {NOTHING_CHANGED}"))?;
    if !pin_set {
        return Ok(format!("No PIN is set. {NOTHING_CHANGED}"));
    }

    if system_auth_available() {
        println!("Enter your Ubuntu password in the window that opens.");
        if !ask_system_password() {
            return Err(format!(
                "The Ubuntu password was not accepted. {NOTHING_CHANGED}"
            ));
        }
    }

    // The notice and the removal in one write: never a reset nobody is told
    // about, nor a notice for a PIN that was kept.
    db.reset_pin(now_ms())
        .map_err(|e| format!("The PIN could not be removed: {e}. {NOTHING_CHANGED}"))?;
    Ok(
        "The PIN was removed. Private notes are no longer locked. DeskNotes will say so \
        at its next start; choose a new PIN in Settings → Privacy to lock them again."
            .into(),
    )
}

#[cfg(test)]
mod tests {
    use super::{APP_IDENTIFIER, NOTHING_CHANGED, RESET_PIN_ARG, open_error, requested};
    use crate::state::startup_message;
    use desknotes_core::CoreError;

    #[test]
    fn newer_database_gets_the_plain_message_without_nothing_changed() {
        let newer = CoreError::SchemaTooNew {
            found: 9,
            supported: 4,
        };
        assert_eq!(open_error(&newer), startup_message(&newer));
        assert!(!open_error(&newer).contains(NOTHING_CHANGED));
    }

    #[test]
    fn other_open_errors_keep_this_commands_wording() {
        let other = CoreError::NotAllowed("refusing to overwrite".into());
        assert_eq!(
            open_error(&other),
            format!("The notes database could not be opened: {other}. {NOTHING_CHANGED}")
        );
    }

    #[test]
    fn identifier_matches_the_tauri_config() {
        let conf: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).expect("tauri.conf.json");
        assert_eq!(conf["identifier"].as_str(), Some(APP_IDENTIFIER));
    }

    #[test]
    fn only_the_flag_after_the_program_name_counts() {
        let args = |list: &[&str]| list.iter().map(|a| a.into()).collect::<Vec<_>>();
        assert!(requested(args(&["desknotes", RESET_PIN_ARG])));
        assert!(!requested(args(&["desknotes"])));
        assert!(!requested(args(&[RESET_PIN_ARG])));
        assert!(!requested(args(&["desknotes", "--reset-pin=1"])));
    }
}
