//! Privacy lock commands (design §4.1–4.6). The PIN is checked here, in Rust,
//! before anything is unlocked or changed; there is no command that turns the
//! lock off without a correct PIN. PINs and recovery codes are never logged,
//! and a recovery code is only ever returned to the Settings window.

use desknotes_core::db::PinCheck;
use desknotes_core::privacy::{PIN_DIGITS, validate_new_pin};
use desknotes_core::validation::parse_note_id;
use desknotes_core::{CoreError, now_ms};
use serde::Serialize;
use tauri::{AppHandle, State, WebviewWindow};

use super::settings::only_from_settings;
use crate::error::{IpcError, IpcResult};
use crate::platform::system_auth::system_auth_available;
use crate::privacy::{self, emit_privacy_changed, recovery_mode};
use crate::state::AppState;
use crate::tray;
use crate::windows::emit_changed;

const PRIVACY: &str = "The privacy lock";

/// What Settings and the windows need to know about the lock.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrivacyStatus {
    /// A PIN is set.
    pub enabled: bool,
    /// Private notes are locked now.
    pub locked: bool,
    pub lock_after_minutes: u32,
    /// "system" (Ubuntu password), "code" (recovery code) or "none".
    pub recovery: &'static str,
    /// When `desknotes --reset-pin` reset the PIN (Unix ms), until acknowledged.
    pub reset_at: Option<i64>,
}

/// Result of choosing a PIN.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetupResult {
    /// Shown once, where the Ubuntu password cannot be used (design D6).
    pub recovery_code: Option<String>,
}

/// A PIN is exactly 6 digits; anything else is refused without checking it.
fn plausible_pin(pin: &str) -> IpcResult<()> {
    if pin.len() == PIN_DIGITS && pin.bytes().all(|b| b.is_ascii_digit()) {
        Ok(())
    } else {
        Err(IpcError::new(
            "validation",
            format!("The PIN is {PIN_DIGITS} digits."),
        ))
    }
}

#[tauri::command]
pub fn privacy_status(state: State<'_, AppState>) -> IpcResult<PrivacyStatus> {
    let system = system_auth_available();
    state.with_db(|db| {
        Ok(PrivacyStatus {
            enabled: db.pin_is_set()?,
            locked: db.privacy_locked(),
            lock_after_minutes: db.lock_after_minutes()?,
            recovery: recovery_mode(system, db.has_recovery_code()?),
            reset_at: db.pin_reset_at()?,
        })
    })
}

/// Unlock every private note with the PIN (design D7). Wrong PINs start the
/// growing waits (D8); the result says how long.
#[tauri::command]
pub async fn unlock(
    app: AppHandle,
    state: State<'_, AppState>,
    pin: String,
) -> IpcResult<PinCheck> {
    plausible_pin(&pin)?;
    let check = state.with_db(|db| {
        let check = db.check_pin(&pin, now_ms())?;
        if check == PinCheck::Ok {
            db.set_privacy_locked(false, &[]);
        }
        Ok(check)
    })?;
    if check == PinCheck::Ok {
        state.touch_activity();
        emit_privacy_changed(&app, false);
    }
    Ok(check)
}

/// "Lock now": save every open note, then lock private notes. Resolves when done.
#[tauri::command]
pub async fn lock_now(app: AppHandle) -> IpcResult<()> {
    tauri::async_runtime::spawn_blocking(move || privacy::lock(&app))
        .await
        .map_err(|e| IpcError::new("internal", e.to_string()))?
}

/// Turn the lock on with a first PIN. Where the Ubuntu password cannot be used,
/// also makes the recovery code, shown once. Either both are stored or neither.
#[tauri::command]
pub async fn setup_pin(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, AppState>,
    pin: String,
) -> IpcResult<SetupResult> {
    only_from_settings(&window, PRIVACY)?;
    let system = system_auth_available();
    let recovery_code = state.with_db(|db| {
        if db.pin_is_set()? {
            return Err(CoreError::NotAllowed("a PIN is already set".into()));
        }
        db.set_new_pin(&pin)?;
        // Notes open now stay unlocked; the lock comes on at the next trigger.
        db.set_privacy_locked(false, &[]);
        if system {
            return Ok(None);
        }
        match db.issue_recovery_code() {
            Ok(code) => Ok(Some(code)),
            Err(e) => {
                // Never leave a PIN with no way back (Ruling R8).
                if let Err(undo) = db.clear_pin() {
                    eprintln!("DeskNotes: the new PIN could not be removed: {undo}");
                }
                Err(e)
            }
        }
    })?;
    tray::refresh(&app);
    emit_privacy_changed(&app, false);
    Ok(SetupResult { recovery_code })
}

/// Settings → Change PIN: the current PIN, then the new one.
#[tauri::command]
pub async fn change_pin(
    window: WebviewWindow,
    state: State<'_, AppState>,
    current: String,
    new: String,
) -> IpcResult<PinCheck> {
    only_from_settings(&window, PRIVACY)?;
    plausible_pin(&current)?;
    validate_new_pin(&new)?;
    state.with_db(|db| {
        let check = db.check_pin(&current, now_ms())?;
        if check == PinCheck::Ok {
            db.set_new_pin(&new)?;
        }
        Ok(check)
    })
}

/// Turn the lock off: needs the PIN. Private flags and labels are kept.
#[tauri::command]
pub async fn turn_off_lock(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, AppState>,
    pin: String,
) -> IpcResult<PinCheck> {
    only_from_settings(&window, PRIVACY)?;
    plausible_pin(&pin)?;
    let check = state.with_db(|db| {
        let check = db.check_pin(&pin, now_ms())?;
        if check == PinCheck::Ok {
            db.clear_pin()?;
        }
        Ok(check)
    })?;
    if check == PinCheck::Ok {
        tray::refresh(&app);
        emit_privacy_changed(&app, false);
    }
    Ok(check)
}

/// Replace the recovery code (Settings, design D6). `None` when the PIN was
/// not accepted; `privacy_status` is unchanged, and a wait may have started.
#[tauri::command]
pub async fn new_recovery_code(
    window: WebviewWindow,
    state: State<'_, AppState>,
    pin: String,
) -> IpcResult<Option<String>> {
    only_from_settings(&window, PRIVACY)?;
    plausible_pin(&pin)?;
    state.with_db(|db| {
        if db.check_pin(&pin, now_ms())? != PinCheck::Ok {
            return Ok(None);
        }
        db.issue_recovery_code().map(Some)
    })
}

/// Minutes of inactivity before private notes lock: 1, 5, 10 or 15.
#[tauri::command]
pub fn set_lock_after(
    window: WebviewWindow,
    state: State<'_, AppState>,
    minutes: u32,
) -> IpcResult<()> {
    only_from_settings(&window, PRIVACY)?;
    state.with_db(|db| db.set_lock_after_minutes(minutes))
}

/// Make a note private (with an optional label shown while locked) or not.
/// Needs a PIN; the core refuses any change to a locked private note.
#[tauri::command]
pub fn set_note_private(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    private: bool,
    label: Option<String>,
) -> IpcResult<()> {
    let id = parse_note_id(&id)?;
    state.with_db(|db| {
        if !db.pin_is_set()? {
            return Err(CoreError::NotAllowed(
                "set up a PIN before making notes private".into(),
            ));
        }
        db.set_private(&id, private, label.as_deref().unwrap_or(""))
    })?;
    emit_changed(&app, Some(&id), "other");
    Ok(())
}

/// Input seen in a DeskNotes window, for the inactivity lock.
#[tauri::command]
pub fn report_activity(state: State<'_, AppState>) {
    state.touch_activity();
}

/// The person saw "The PIN was reset on <date>".
#[tauri::command]
pub fn acknowledge_pin_reset(state: State<'_, AppState>) -> IpcResult<()> {
    state.with_db(|db| db.acknowledge_pin_reset())
}

#[cfg(test)]
mod tests {
    use super::plausible_pin;

    #[test]
    fn only_six_digits_are_checked() {
        assert!(plausible_pin("482915").is_ok());
        for bad in ["", "48291", "4829150", "48291a", "４８２９１５", " 48291"] {
            assert_eq!(
                plausible_pin(bad).unwrap_err().code,
                "validation",
                "{bad:?}"
            );
        }
    }
}
