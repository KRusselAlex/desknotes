//! Privacy lock commands (design §4.1–4.6). The PIN is checked here, in Rust,
//! before anything is unlocked or changed; there is no command that turns the
//! lock off without a correct PIN, the Ubuntu password or the recovery code.
//! PINs and recovery codes are never logged, and a recovery code is only ever
//! returned to the Settings window.
//!
//! Forgotten PIN (§4.6, Ruling R17): `forgot_pin_system` or `recover_with_code`,
//! from any window, only prove who is asking (they return success or a
//! `PinCheck`, never a code). On success the UI opens Settings → Privacy, where
//! `choose_new_pin` (Settings only) stores the new PIN and, where the Ubuntu
//! password cannot be used, returns the new recovery code.

use std::sync::atomic::{AtomicBool, Ordering};

use desknotes_core::db::PinCheck;
use desknotes_core::privacy::{PIN_DIGITS, validate_new_pin};
use desknotes_core::validation::parse_note_id;
use desknotes_core::{CoreError, CoreResult, Database, now_ms};
use serde::Serialize;
use tauri::{AppHandle, State, WebviewWindow};

use super::settings::{only_from_settings, only_from_settings_label};
use crate::error::{IpcError, IpcResult};
use crate::platform::system_auth::{ask_system_password, system_auth_available};
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

/// Store a new PIN and, when `issue_code`, a new recovery code (replacing any
/// earlier one). Either both are stored or neither: a PIN with no way back is
/// never left (Ruling R8). Returns the code, to be shown once.
fn store_pin_with_code(db: &Database, pin: &str, issue_code: bool) -> CoreResult<Option<String>> {
    db.set_new_pin(pin)?;
    if !issue_code {
        return Ok(None);
    }
    match db.issue_recovery_code() {
        Ok(code) => Ok(Some(code)),
        Err(e) => {
            if let Err(undo) = db.clear_pin() {
                eprintln!("DeskNotes: the new PIN could not be removed: {undo}");
            }
            Err(e)
        }
    }
}

/// Replace a forgotten PIN. Needs the one-shot permission given by the Ubuntu
/// password or a recovery code; it is used up by this call, whatever happens.
fn replace_forgotten_pin(
    db: &Database,
    allowed: &AtomicBool,
    pin: &str,
    issue_code: bool,
) -> CoreResult<Option<String>> {
    if !allowed.swap(false, Ordering::AcqRel) {
        return Err(CoreError::NotAllowed(
            "enter the Ubuntu password or the recovery code first".into(),
        ));
    }
    store_pin_with_code(db, pin, issue_code)
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
        let code = store_pin_with_code(db, &pin, !system)?;
        // Notes open now stay unlocked; the lock comes on at the next trigger.
        db.set_privacy_locked(false, &[]);
        Ok(code)
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

/// Only one Ubuntu password dialog at a time.
static SYSTEM_PROMPT_OPEN: AtomicBool = AtomicBool::new(false);

/// A forgotten PIN was proven by the Ubuntu password or the recovery code:
/// unlock every private note and allow one new PIN without the old one. Called
/// with the database lock held, so a lock cannot slip in between (a lock
/// clears the permission again).
fn accept_proof(db: &Database, state: &AppState) {
    db.set_privacy_locked(false, &[]);
    state.new_pin_allowed.store(true, Ordering::Release);
}

/// "Forgot your PIN?" where the Ubuntu password can be used (design D5): the
/// system's own password dialog. `true`: private notes are unlocked and
/// `choose_new_pin` may be called once. `false` (wrong password, cancelled):
/// nothing changed. Any window.
#[tauri::command]
pub async fn forgot_pin_system(app: AppHandle, state: State<'_, AppState>) -> IpcResult<bool> {
    if !system_auth_available() {
        return Err(IpcError::new(
            "not_allowed",
            "The Ubuntu password cannot be used here. Use the recovery code.",
        ));
    }
    if !state.with_db(|db| db.pin_is_set())? {
        return Err(IpcError::new("not_allowed", "No PIN is set."));
    }
    if SYSTEM_PROMPT_OPEN.swap(true, Ordering::AcqRel) {
        return Err(IpcError::new(
            "not_allowed",
            "The Ubuntu password is already being asked for.",
        ));
    }
    // The dialog blocks until it closes: off the main thread, no database lock held.
    let asked = tauri::async_runtime::spawn_blocking(ask_system_password).await;
    SYSTEM_PROMPT_OPEN.store(false, Ordering::Release);
    let accepted = asked.map_err(|e| IpcError::new("internal", e.to_string()))?;
    if !accepted {
        return Ok(false);
    }
    // The PIN may have been removed while the dialog was open.
    if !state.with_db(|db| {
        let pin_set = db.pin_is_set()?;
        if pin_set {
            accept_proof(db, &state);
        }
        Ok(pin_set)
    })? {
        return Ok(false);
    }
    state.touch_activity();
    emit_privacy_changed(&app, false);
    Ok(true)
}

/// Longest recovery-code entry looked at: 24 characters with spaces or dashes.
const MAX_RECOVERY_INPUT: usize = 64;

/// "Forgot your PIN?" with the recovery code (design D6). Spacing, dashes and
/// case do not matter; wrong codes share the wrong-PIN waits. On `ok`: private
/// notes are unlocked and `choose_new_pin` may be called once. Any window.
#[tauri::command]
pub async fn recover_with_code(
    app: AppHandle,
    state: State<'_, AppState>,
    code: String,
) -> IpcResult<PinCheck> {
    if code.len() > MAX_RECOVERY_INPUT {
        return Err(IpcError::new(
            "validation",
            "The recovery code is 24 letters and digits.",
        ));
    }
    let check = state.with_db(|db| {
        let check = db.check_recovery_code(&code, now_ms())?;
        if check == PinCheck::Ok {
            accept_proof(db, &state);
        }
        Ok(check)
    })?;
    if check == PinCheck::Ok {
        state.touch_activity();
        emit_privacy_changed(&app, false);
    }
    Ok(check)
}

/// Only the Settings window may choose the new PIN: it may receive a new
/// recovery code, and codes go to Settings only (Ruling R17).
fn choose_new_pin_window(label: &str) -> IpcResult<()> {
    only_from_settings_label(label, PRIVACY)
}

/// Settings only. Choose a new PIN after `forgot_pin_system` or
/// `recover_with_code` succeeded (one new PIN per proof; a lock in between
/// cancels it → `not_allowed`). Where the Ubuntu password cannot be used, a new
/// recovery code replaces the old one and is returned, shown once. Another
/// window or a weak PIN is refused without using up the proof.
#[tauri::command]
pub async fn choose_new_pin(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, AppState>,
    pin: String,
) -> IpcResult<SetupResult> {
    choose_new_pin_window(window.label())?;
    validate_new_pin(&pin)?;
    let issue_code = !system_auth_available();
    let result =
        state.with_db(|db| replace_forgotten_pin(db, &state.new_pin_allowed, &pin, issue_code));
    // The R8 rollback may have removed the PIN: the tray follows either way.
    tray::refresh(&app);
    let recovery_code = result?;
    emit_privacy_changed(&app, false);
    Ok(SetupResult { recovery_code })
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

/// Making a note private needs a PIN (marking it private first starts the PIN
/// setup, §4.1). Making it not private does not: with no PIN there is no lock,
/// and flags kept from an earlier lock must stay removable.
fn needs_pin_first(pin_set: bool, private: bool) -> bool {
    private && !pin_set
}

/// Make a note private (with an optional label shown while locked) or not.
/// While the lock is on, the core refuses any change to a private note (kept
/// open or not): its label and "Make not private" need the PIN.
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
        if needs_pin_first(db.pin_is_set()?, private) {
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
    use std::sync::atomic::{AtomicBool, Ordering};

    use desknotes_core::db::PinCheck;
    use desknotes_core::{CoreError, Database};

    use super::{choose_new_pin_window, needs_pin_first, plausible_pin, replace_forgotten_pin};

    #[test]
    fn choose_new_pin_only_from_settings() {
        assert!(choose_new_pin_window("settings").is_ok());
        for other in [
            "manager",
            "note-0b9d6f6e-3f0a-4b8e-9a51-2a4c1d7e8f90",
            "",
            "Settings",
        ] {
            let refused = choose_new_pin_window(other).unwrap_err();
            assert_eq!(refused.code, "not_allowed", "{other:?}");
            assert_eq!(
                refused.message, "The privacy lock can only be changed in Settings.",
                "{other:?}"
            );
        }
    }

    #[test]
    fn choose_new_pin_needs_a_proof() {
        let db = Database::open_in_memory().unwrap();
        db.set_new_pin("482915").unwrap();
        let allowed = AtomicBool::new(false);

        let refused = replace_forgotten_pin(&db, &allowed, "730518", false).unwrap_err();
        assert!(matches!(refused, CoreError::NotAllowed(_)), "{refused:?}");
        assert_eq!(
            db.check_pin("482915", 0).unwrap(),
            PinCheck::Ok,
            "unchanged"
        );

        // After the Ubuntu password or a recovery code: one new PIN, once.
        allowed.store(true, Ordering::SeqCst);
        assert_eq!(
            replace_forgotten_pin(&db, &allowed, "730518", false).unwrap(),
            None
        );
        assert!(!allowed.load(Ordering::SeqCst), "the proof is used up");
        assert_eq!(db.check_pin("730518", 0).unwrap(), PinCheck::Ok);
        let again = replace_forgotten_pin(&db, &allowed, "264093", false).unwrap_err();
        assert!(matches!(again, CoreError::NotAllowed(_)), "{again:?}");
    }

    #[test]
    fn a_new_pin_comes_with_a_new_code_where_the_code_is_the_way_back() {
        let db = Database::open_in_memory().unwrap();
        db.set_new_pin("482915").unwrap();
        let old = db.issue_recovery_code().unwrap();
        let allowed = AtomicBool::new(true);

        let new = replace_forgotten_pin(&db, &allowed, "730518", true)
            .unwrap()
            .expect("a new recovery code");
        assert_ne!(new, old);
        assert_eq!(db.check_recovery_code(&new, 0).unwrap(), PinCheck::Ok);
        assert!(matches!(
            db.check_recovery_code(&old, 0).unwrap(),
            PinCheck::Wrong { .. }
        ));
    }

    #[test]
    fn only_making_private_needs_a_pin() {
        assert!(needs_pin_first(false, true));
        assert!(
            !needs_pin_first(false, false),
            "flags stay removable without a PIN"
        );
        assert!(!needs_pin_first(true, true));
        assert!(!needs_pin_first(true, false));
    }

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
