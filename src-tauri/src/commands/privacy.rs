//! Privacy lock commands (design §4.1–4.6). The PIN is checked here, in Rust,
//! before anything is unlocked or changed; there is no command that turns the
//! lock off without a correct PIN, the Ubuntu password or the recovery code.
//! PINs and recovery codes are never logged, and a recovery code is only ever
//! returned to the Settings window.
//!
//! Forgotten PIN (§4.6, Ruling R17): `forgot_pin_system` or `recover_with_code`,
//! from any window, only prove who is asking (they return success or a
//! `PinCheck`, never a code). On success the UI opens Settings → Privacy, where
//! `choose_new_pin` (Settings only) stores the new PIN and, where the recovery
//! code is the way back, returns the new recovery code.
//!
//! The way back is the owner's choice (design D14): "Use my computer password"
//! (only where the Ubuntu password can be used) or "Use a recovery code", made
//! with `setup_pin` and changed with `set_recovery_method` (current PIN needed).

use std::sync::atomic::{AtomicBool, Ordering};

use desknotes_core::db::{PinCheck, RecoveryMethod};
use desknotes_core::privacy::{PIN_DIGITS, validate_new_pin};
use desknotes_core::validation::parse_note_id;
use desknotes_core::{CoreError, CoreResult, Database, now_ms};
use serde::Serialize;
use tauri::{AppHandle, State, WebviewWindow};

use super::settings::{only_from_settings, only_from_settings_label};
use crate::error::{IpcError, IpcResult};
use crate::platform::system_auth::{ask_system_password, system_auth_available};
use crate::privacy::{self, emit_privacy_changed, recovery_mode, system_route_allowed};
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
    /// What "Forgot your PIN?" uses here: "system" (Ubuntu password), "code"
    /// (recovery code) or "none".
    pub recovery: &'static str,
    /// The owner's choice (D14); `null` when none is stored (no PIN, or a PIN
    /// set before D14).
    pub recovery_method: Option<RecoveryMethod>,
    /// The Ubuntu password can be used here, so "Use my computer password" may
    /// be offered.
    pub system_available: bool,
    /// When `desknotes --reset-pin` reset the PIN (Unix ms), until acknowledged.
    pub reset_at: Option<i64>,
}

/// Result of choosing a PIN.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetupResult {
    /// Shown once, where the recovery code is the way back (design D6, D14).
    pub recovery_code: Option<String>,
}

/// Result of changing how a forgotten PIN is replaced (design D14).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryChange {
    /// Anything but `ok`: nothing changed (a wait may have started).
    pub check: PinCheck,
    /// The new recovery code when switching to "code", shown once.
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

/// "Use my computer password" only where the Ubuntu password can be used (D14):
/// elsewhere, or with no password set, polkit would protect nothing.
fn method_usable(method: RecoveryMethod, system_auth: bool) -> CoreResult<()> {
    if method == RecoveryMethod::System && !system_auth {
        return Err(CoreError::NotAllowed(
            "the Ubuntu password cannot be used here; choose a recovery code".into(),
        ));
    }
    Ok(())
}

/// A new PIN after forgetting the old one comes with a new recovery code
/// unless the Ubuntu password is the way back.
fn issue_code_with_new_pin(method: Option<RecoveryMethod>, system_auth: bool) -> bool {
    !system_route_allowed(method, system_auth)
}

/// The first PIN with the chosen way back: a recovery code only for "code";
/// for "system" any stray code is removed so only the chosen way works. Either
/// all is stored or nothing (Ruling R8). Callers check `method_usable` first.
fn store_first_pin(db: &Database, pin: &str, method: RecoveryMethod) -> CoreResult<Option<String>> {
    if db.pin_is_set()? {
        return Err(CoreError::NotAllowed("a PIN is already set".into()));
    }
    let code = store_pin_with_code(db, pin, method == RecoveryMethod::Code)?;
    let rest = db.set_recovery_method(method).and_then(|()| match method {
        RecoveryMethod::System => db.clear_recovery_code(),
        RecoveryMethod::Code => Ok(()),
    });
    if let Err(e) = rest {
        if let Err(undo) = db.clear_pin() {
            eprintln!("DeskNotes: the new PIN could not be removed: {undo}");
        }
        return Err(e);
    }
    Ok(code)
}

/// Settings → "If I forget my PIN" (D14), after the current PIN (shared
/// throttle; anything but `ok` changes nothing). Callers check `method_usable`.
fn change_recovery_method(
    db: &Database,
    pin: &str,
    method: RecoveryMethod,
    now_ms: i64,
) -> CoreResult<RecoveryChange> {
    let check = db.check_pin(pin, now_ms)?;
    if check != PinCheck::Ok {
        return Ok(RecoveryChange {
            check,
            recovery_code: None,
        });
    }
    // One transaction: on error the earlier choice and code stay as they were.
    let recovery_code = db.switch_recovery_method(method)?;
    Ok(RecoveryChange {
        check,
        recovery_code,
    })
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
    if !issue_code {
        // The Ubuntu password is the way back: a recovery code kept from a PIN set
        // before D14 stops working too. Removed first, so a failure below leaves
        // the old PIN with the Ubuntu password still able to replace it.
        db.clear_recovery_code()?;
    }
    store_pin_with_code(db, pin, issue_code)
}

/// Settings → Change PIN, after the current PIN. A new PIN ends any proof of a
/// forgotten one, which was given for the old PIN.
fn change_known_pin(
    db: &Database,
    allowed: &AtomicBool,
    current: &str,
    new: &str,
    now_ms: i64,
) -> CoreResult<PinCheck> {
    let check = db.check_pin(current, now_ms)?;
    if check == PinCheck::Ok {
        db.set_new_pin(new)?;
        allowed.store(false, Ordering::Release);
    }
    Ok(check)
}

/// Settings → turn the lock off, after the PIN. Also ends any proof of a
/// forgotten PIN, so it cannot choose a PIN set up later.
fn remove_pin(db: &Database, allowed: &AtomicBool, pin: &str, now_ms: i64) -> CoreResult<PinCheck> {
    let check = db.check_pin(pin, now_ms)?;
    if check == PinCheck::Ok {
        db.clear_pin()?;
        allowed.store(false, Ordering::Release);
    }
    Ok(check)
}

/// After `choose_new_pin`: windows hear of a new PIN, and of a PIN the R8
/// rollback removed. A refusal changed nothing and may come while the lock is
/// on, so it says nothing; neither does a PIN state that cannot be read.
fn windows_must_hear(stored: bool, pin_set_now: Option<bool>) -> bool {
    stored || pin_set_now == Some(false)
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
        let method = db.recovery_method()?;
        Ok(PrivacyStatus {
            enabled: db.pin_is_set()?,
            locked: db.privacy_locked(),
            lock_after_minutes: db.lock_after_minutes()?,
            recovery: recovery_mode(method, system, db.has_recovery_code()?),
            recovery_method: method,
            system_available: system,
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

/// Turn the lock on with a first PIN and the way back if it is forgotten
/// (D14): "system" (refused where the Ubuntu password cannot be used) or
/// "code", which also makes the recovery code, shown once. Either all is
/// stored or nothing.
#[tauri::command]
pub async fn setup_pin(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, AppState>,
    pin: String,
    method: RecoveryMethod,
) -> IpcResult<SetupResult> {
    only_from_settings(&window, PRIVACY)?;
    method_usable(method, system_auth_available())?;
    let recovery_code = state.with_db(|db| {
        let code = store_first_pin(db, &pin, method)?;
        // Notes open now stay unlocked; the lock comes on at the next trigger.
        db.set_privacy_locked(false, &[]);
        // No proof of a forgotten PIN outlives the PIN it was given for.
        state.new_pin_allowed.store(false, Ordering::Release);
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
    state.with_db(|db| change_known_pin(db, &state.new_pin_allowed, &current, &new, now_ms()))
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
    let check = state.with_db(|db| remove_pin(db, &state.new_pin_allowed, &pin, now_ms()))?;
    if check == PinCheck::Ok {
        tray::refresh(&app);
        emit_privacy_changed(&app, false);
    }
    Ok(check)
}

/// Settings → "If I forget my PIN" (D14): needs the current PIN. To "code":
/// a new recovery code, returned once. To "system" (only where the Ubuntu
/// password can be used): the old recovery code stops working.
#[tauri::command]
pub async fn set_recovery_method(
    window: WebviewWindow,
    state: State<'_, AppState>,
    pin: String,
    method: RecoveryMethod,
) -> IpcResult<RecoveryChange> {
    only_from_settings(&window, PRIVACY)?;
    plausible_pin(&pin)?;
    method_usable(method, system_auth_available())?;
    state.with_db(|db| change_recovery_method(db, &pin, method, now_ms()))
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

/// "Forgot your PIN?" where the Ubuntu password can be used and the owner did
/// not choose a recovery code instead (design D5, D14): the
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
    let (pin_set, method) = state.with_db(|db| Ok((db.pin_is_set()?, db.recovery_method()?)))?;
    if !pin_set {
        return Err(IpcError::new("not_allowed", "No PIN is set."));
    }
    if !system_route_allowed(method, true) {
        return Err(IpcError::new(
            "not_allowed",
            "A recovery code was chosen for a forgotten PIN. Use the recovery code.",
        ));
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
    // The PIN may have been removed, or a recovery code chosen, while the
    // dialog was open.
    if !state.with_db(|db| {
        let still = db.pin_is_set()? && system_route_allowed(db.recovery_method()?, true);
        if still {
            accept_proof(db, &state);
        }
        Ok(still)
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
/// cancels it → `not_allowed`). Where the recovery code is the way back (chosen,
/// or the Ubuntu password cannot be used), a new recovery code replaces the old
/// one and is returned, shown once. Another
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
    let system = system_auth_available();
    let result = state.with_db(|db| {
        let issue_code = issue_code_with_new_pin(db.recovery_method()?, system);
        replace_forgotten_pin(db, &state.new_pin_allowed, &pin, issue_code)
    });
    // The R8 rollback may have removed the PIN: the tray follows either way, and
    // windows hear of it as of a new PIN.
    tray::refresh(&app);
    let pin_set_now = state.with_db(|db| db.pin_is_set()).ok();
    if windows_must_hear(result.is_ok(), pin_set_now) {
        emit_privacy_changed(&app, false);
    }
    let recovery_code = result?;
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
    if private {
        // Made private while the lock is on: its title may now be withheld (R10).
        crate::reminders::on_locked(&app);
    }
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

    use desknotes_core::db::RecoveryMethod;

    use super::{
        RecoveryChange, change_known_pin, change_recovery_method, choose_new_pin_window,
        issue_code_with_new_pin, method_usable, needs_pin_first, plausible_pin, remove_pin,
        replace_forgotten_pin, store_first_pin, system_route_allowed, windows_must_hear,
    };

    #[test]
    fn changing_or_removing_the_pin_ends_a_forgotten_pin_proof() {
        // A proof given for the old PIN must not choose a PIN later (DES-30).
        let db = Database::open_in_memory().unwrap();
        db.set_new_pin("482915").unwrap();
        let allowed = AtomicBool::new(true);
        assert!(matches!(
            change_known_pin(&db, &allowed, "000001", "730518", 0).unwrap(),
            PinCheck::Wrong { .. }
        ));
        assert!(
            allowed.load(Ordering::SeqCst),
            "a wrong PIN changes nothing"
        );
        assert_eq!(
            change_known_pin(&db, &allowed, "482915", "730518", 0).unwrap(),
            PinCheck::Ok
        );
        assert!(!allowed.load(Ordering::SeqCst));
        assert_eq!(db.check_pin("730518", 0).unwrap(), PinCheck::Ok);

        allowed.store(true, Ordering::SeqCst);
        assert!(matches!(
            remove_pin(&db, &allowed, "000001", 0).unwrap(),
            PinCheck::Wrong { .. }
        ));
        assert!(allowed.load(Ordering::SeqCst));
        assert!(db.pin_is_set().unwrap());
        assert_eq!(
            remove_pin(&db, &allowed, "730518", 0).unwrap(),
            PinCheck::Ok
        );
        assert!(!allowed.load(Ordering::SeqCst));
        assert!(!db.pin_is_set().unwrap());
    }

    #[test]
    fn a_new_pin_by_the_ubuntu_password_retires_an_older_recovery_code() {
        // A PIN set before D14 may have a recovery code and no method; once the Ubuntu
        // password chose the new PIN, only that way back may work (DES-30).
        let db = Database::open_in_memory().unwrap();
        db.set_new_pin("482915").unwrap();
        let old = db.issue_recovery_code().unwrap();
        let allowed = AtomicBool::new(true);
        assert_eq!(
            replace_forgotten_pin(&db, &allowed, "730518", false).unwrap(),
            None
        );
        assert!(!db.has_recovery_code().unwrap());
        assert!(matches!(
            db.check_recovery_code(&old, 0).unwrap_err(),
            CoreError::NotAllowed(_)
        ));
        assert_eq!(db.check_pin("730518", 0).unwrap(), PinCheck::Ok);
    }

    #[test]
    fn windows_hear_of_a_new_pin_and_of_a_pin_a_rollback_removed() {
        assert!(windows_must_hear(true, Some(true)), "a new PIN");
        assert!(
            windows_must_hear(false, Some(false)),
            "the R8 rollback removed the PIN"
        );
        assert!(
            !windows_must_hear(false, Some(true)),
            "refused: nothing changed, and the lock may be on"
        );
        assert!(!windows_must_hear(false, None), "unknown: say nothing");
    }

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
    fn system_method_needs_system_auth() {
        assert!(method_usable(RecoveryMethod::System, true).is_ok());
        let refused = method_usable(RecoveryMethod::System, false).unwrap_err();
        assert!(matches!(refused, CoreError::NotAllowed(_)), "{refused:?}");
        assert_eq!(refused.code(), "not_allowed");
        assert!(method_usable(RecoveryMethod::Code, true).is_ok());
        assert!(method_usable(RecoveryMethod::Code, false).is_ok());
    }

    #[test]
    fn the_system_route_follows_the_chosen_method() {
        assert!(system_route_allowed(Some(RecoveryMethod::System), true));
        assert!(system_route_allowed(None, true), "PINs set before D14");
        assert!(!system_route_allowed(Some(RecoveryMethod::Code), true));
        assert!(!system_route_allowed(Some(RecoveryMethod::System), false));
        assert!(!system_route_allowed(None, false));
    }

    #[test]
    fn a_new_pin_after_forgetting_gets_a_code_where_the_code_is_the_way_back() {
        assert!(issue_code_with_new_pin(Some(RecoveryMethod::Code), true));
        assert!(issue_code_with_new_pin(Some(RecoveryMethod::Code), false));
        assert!(issue_code_with_new_pin(Some(RecoveryMethod::System), false));
        assert!(issue_code_with_new_pin(None, false));
        assert!(!issue_code_with_new_pin(Some(RecoveryMethod::System), true));
        assert!(!issue_code_with_new_pin(None, true));
    }

    #[test]
    fn first_pin_stores_the_method_and_a_code_only_for_code() {
        let db = Database::open_in_memory().unwrap();
        assert_eq!(
            store_first_pin(&db, "482915", RecoveryMethod::System).unwrap(),
            None
        );
        assert_eq!(db.recovery_method().unwrap(), Some(RecoveryMethod::System));
        assert!(!db.has_recovery_code().unwrap());
        let again = store_first_pin(&db, "730518", RecoveryMethod::Code).unwrap_err();
        assert!(matches!(again, CoreError::NotAllowed(_)), "{again:?}");
        assert_eq!(db.recovery_method().unwrap(), Some(RecoveryMethod::System));

        let db = Database::open_in_memory().unwrap();
        let code = store_first_pin(&db, "482915", RecoveryMethod::Code)
            .unwrap()
            .expect("a recovery code");
        assert_eq!(db.recovery_method().unwrap(), Some(RecoveryMethod::Code));
        assert_eq!(db.check_recovery_code(&code, 0).unwrap(), PinCheck::Ok);

        // A weak PIN stores nothing.
        let db = Database::open_in_memory().unwrap();
        let weak = store_first_pin(&db, "123456", RecoveryMethod::Code).unwrap_err();
        assert_eq!(weak.code(), "validation");
        assert!(!db.pin_is_set().unwrap());
        assert_eq!(db.recovery_method().unwrap(), None);
        assert!(!db.has_recovery_code().unwrap());
    }

    #[test]
    fn changing_the_method_needs_the_pin_and_retires_the_old_code() {
        let db = Database::open_in_memory().unwrap();
        db.set_new_pin("482915").unwrap();
        db.set_recovery_method(RecoveryMethod::System).unwrap();

        // Wrong PIN: nothing changes, the wait counter grows.
        let wrong = change_recovery_method(&db, "000000", RecoveryMethod::Code, 0).unwrap();
        assert_eq!(wrong.check, PinCheck::Wrong { wait_secs: 0 });
        assert_eq!(wrong.recovery_code, None);
        assert_eq!(db.recovery_method().unwrap(), Some(RecoveryMethod::System));
        assert!(!db.has_recovery_code().unwrap());

        // To a code: a new one, returned once.
        let to_code = change_recovery_method(&db, "482915", RecoveryMethod::Code, 0).unwrap();
        assert_eq!(to_code.check, PinCheck::Ok);
        let code = to_code.recovery_code.expect("a recovery code");
        assert_eq!(db.recovery_method().unwrap(), Some(RecoveryMethod::Code));
        assert_eq!(db.check_recovery_code(&code, 0).unwrap(), PinCheck::Ok);

        // Back to the computer password: the code stops working.
        let to_system = change_recovery_method(&db, "482915", RecoveryMethod::System, 0).unwrap();
        assert_eq!(to_system.check, PinCheck::Ok);
        assert_eq!(to_system.recovery_code, None);
        assert_eq!(db.recovery_method().unwrap(), Some(RecoveryMethod::System));
        assert!(!db.has_recovery_code().unwrap());

        // The wire format the UI reads.
        let shape = RecoveryChange {
            check: PinCheck::Wrong { wait_secs: 30 },
            recovery_code: Some("ABCD".into()),
        };
        assert_eq!(
            serde_json::to_value(shape).unwrap(),
            serde_json::json!({ "check": { "kind": "wrong", "waitSecs": 30 }, "recoveryCode": "ABCD" })
        );
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
