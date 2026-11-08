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
//!
//! Hashing a PIN or recovery code takes about 0.33 s. It runs on a blocking
//! thread with the database lock released, so note windows are not held up
//! (DES-30), and under `AppState::secrets`, so such work never overlaps.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{MutexGuard, PoisonError};

use desknotes_core::db::{PinCheck, RecoveryChoice, RecoveryMethod, Secret};
use desknotes_core::privacy::{NewPin, NewRecoveryCode, PIN_DIGITS, validate_new_pin};
use desknotes_core::validation::parse_note_id;
use desknotes_core::{CoreError, CoreResult, Database, now_ms};
use serde::Serialize;
use tauri::{AppHandle, Manager, State, WebviewWindow};

use super::settings::{only_from_settings, only_from_settings_label};
use crate::error::{IpcError, IpcResult};
use crate::platform::system_auth::{ask_system_password, system_auth_available};
use crate::privacy::{self, emit_privacy_changed, recovery_mode, system_route_allowed};
use crate::state::{AppState, SharedDb, with_db};
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

/// Held for the whole of PIN and recovery-code work (`AppState::secrets`), and
/// asked for by every check, so checks cannot run side by side.
struct Turn<'a> {
    _guard: MutexGuard<'a, ()>,
}

/// Run PIN and recovery-code work on a blocking thread, taking its turn.
async fn take_turn<T: Send + 'static>(
    app: &AppHandle,
    work: impl FnOnce(&AppState, &Turn) -> IpcResult<T> + Send + 'static,
) -> IpcResult<T> {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        // The mutex guards no data: a panic in earlier work must not shut the
        // owner out of their private notes until a restart.
        let turn = Turn {
            _guard: state.secrets.lock().unwrap_or_else(PoisonError::into_inner),
        };
        work(state.inner(), &turn)
    })
    .await
    .map_err(|e| IpcError::new("internal", e.to_string()))?
}

/// Check `input` against the PIN or recovery code without holding the database
/// lock while it is hashed. On a match, `prepare` makes any new hash, also
/// without the lock, then `apply` runs in the same hold of the lock that records
/// the match, so nothing can slip in between.
fn check_then<P, T>(
    _turn: &Turn,
    db: &SharedDb,
    secret: Secret,
    input: &str,
    now_ms: i64,
    prepare: impl FnOnce() -> CoreResult<P>,
    apply: impl FnOnce(&Database, P) -> CoreResult<T>,
) -> IpcResult<(PinCheck, Option<T>)> {
    let stored = match with_db(db, |db| db.start_check(secret, now_ms))? {
        Ok(stored) => stored,
        Err(waiting) => return Ok((waiting, None)),
    };
    let matched = stored.matches(input);
    let prepared = if matched { Some(prepare()?) } else { None };
    with_db(db, |db| {
        let check = db.finish_check(&stored, matched, now_ms)?;
        match (check, prepared) {
            (PinCheck::Ok, Some(prepared)) => Ok((PinCheck::Ok, Some(apply(db, prepared)?))),
            (check, _) => Ok((check, None)),
        }
    })
}

/// Store a new PIN and, if given, a new recovery code (replacing any earlier
/// one). Either both are stored or neither: a PIN with no way back is never
/// left (Ruling R8). Returns the code, to be shown once.
fn store_pin_with_code(
    db: &Database,
    pin: &NewPin,
    code: Option<NewRecoveryCode>,
) -> CoreResult<Option<String>> {
    db.store_new_pin(pin)?;
    let Some(code) = code else {
        return Ok(None);
    };
    match db.store_recovery_code(&code) {
        Ok(()) => Ok(Some(code.into_code())),
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
fn store_first_pin(
    db: &Database,
    pin: &NewPin,
    choice: RecoveryChoice,
) -> CoreResult<Option<String>> {
    if db.pin_is_set()? {
        return Err(CoreError::NotAllowed("a PIN is already set".into()));
    }
    let method = choice.method();
    let code = store_pin_with_code(db, pin, choice.into_new_code())?;
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
    turn: &Turn,
    db: &SharedDb,
    pin: &str,
    method: RecoveryMethod,
    now_ms: i64,
) -> IpcResult<RecoveryChange> {
    // One transaction: on error the earlier choice and code stay as they were.
    let (check, recovery_code) = check_then(
        turn,
        db,
        Secret::Pin,
        pin,
        now_ms,
        || RecoveryChoice::prepare(method),
        |db, choice| db.apply_recovery_method(choice),
    )?;
    Ok(RecoveryChange {
        check,
        recovery_code: recovery_code.flatten(),
    })
}

fn no_proof() -> CoreError {
    CoreError::NotAllowed("enter the Ubuntu password or the recovery code first".into())
}

/// Replace a forgotten PIN, with a new recovery code if one is given. Needs the
/// one-shot permission given by the Ubuntu password or a recovery code; it is
/// used up by this call, whatever happens.
fn replace_forgotten_pin(
    db: &Database,
    allowed: &AtomicBool,
    pin: &NewPin,
    code: Option<NewRecoveryCode>,
) -> CoreResult<Option<String>> {
    if !allowed.swap(false, Ordering::AcqRel) {
        return Err(no_proof());
    }
    if code.is_none() {
        // The Ubuntu password is the way back: a recovery code kept from a PIN set
        // before D14 stops working too, and the method is stored, so Settings shows
        // it. One transaction, done first: a failure below leaves the old PIN with
        // the Ubuntu password still able to replace it.
        db.switch_recovery_method(RecoveryMethod::System)?;
    }
    store_pin_with_code(db, pin, code)
}

/// Settings → Change PIN, after the current PIN. A new PIN ends any proof of a
/// forgotten one, which was given for the old PIN.
fn change_known_pin(
    turn: &Turn,
    db: &SharedDb,
    allowed: &AtomicBool,
    current: &str,
    new: &str,
    now_ms: i64,
) -> IpcResult<PinCheck> {
    let (check, _) = check_then(
        turn,
        db,
        Secret::Pin,
        current,
        now_ms,
        || NewPin::new(new),
        |db, pin| {
            db.store_new_pin(&pin)?;
            allowed.store(false, Ordering::Release);
            Ok(())
        },
    )?;
    Ok(check)
}

/// Settings → turn the lock off, after the PIN. Also ends any proof of a
/// forgotten PIN, so it cannot choose a PIN set up later.
fn remove_pin(
    turn: &Turn,
    db: &SharedDb,
    allowed: &AtomicBool,
    pin: &str,
    now_ms: i64,
) -> IpcResult<PinCheck> {
    let (check, _) = check_then(
        turn,
        db,
        Secret::Pin,
        pin,
        now_ms,
        || Ok(()),
        |db, ()| {
            db.clear_pin()?;
            allowed.store(false, Ordering::Release);
            Ok(())
        },
    )?;
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
    let (check, unlocked) = take_turn(&app, move |state, turn| {
        let seen = state.lock_epoch.load(Ordering::Acquire);
        check_then(
            turn,
            state.db(),
            Secret::Pin,
            &pin,
            now_ms(),
            || Ok(()),
            |db, ()| Ok(unlock_unless_locked_since(db, &state.lock_epoch, seen)),
        )
    })
    .await?;
    if unlocked == Some(false) {
        return Err(locked_meanwhile("your PIN"));
    }
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
    pin: String,
    method: RecoveryMethod,
) -> IpcResult<SetupResult> {
    only_from_settings(&window, PRIVACY)?;
    validate_new_pin(&pin)?;
    method_usable(method, system_auth_available())?;
    let recovery_code = take_turn(&app, move |state, _turn| {
        // Refused before anything is hashed; checked again when storing.
        if state.with_db(|db| db.pin_is_set())? {
            return Err(CoreError::NotAllowed("a PIN is already set".into()).into());
        }
        let pin = NewPin::new(&pin)?;
        let choice = RecoveryChoice::prepare(method)?;
        state.with_db(|db| {
            let code = store_first_pin(db, &pin, choice)?;
            // Notes open now stay unlocked; the lock comes on at the next trigger.
            db.set_privacy_locked(false, &[]);
            // No proof of a forgotten PIN outlives the PIN it was given for.
            state.new_pin_allowed.store(false, Ordering::Release);
            Ok(code)
        })
    })
    .await?;
    tray::refresh(&app);
    emit_privacy_changed(&app, false);
    Ok(SetupResult { recovery_code })
}

/// Settings → Change PIN: the current PIN, then the new one.
#[tauri::command]
pub async fn change_pin(
    app: AppHandle,
    window: WebviewWindow,
    current: String,
    new: String,
) -> IpcResult<PinCheck> {
    only_from_settings(&window, PRIVACY)?;
    plausible_pin(&current)?;
    validate_new_pin(&new)?;
    take_turn(&app, move |state, turn| {
        change_known_pin(
            turn,
            state.db(),
            &state.new_pin_allowed,
            &current,
            &new,
            now_ms(),
        )
    })
    .await
}

/// Turn the lock off: needs the PIN. Private flags and labels are kept.
#[tauri::command]
pub async fn turn_off_lock(
    app: AppHandle,
    window: WebviewWindow,
    pin: String,
) -> IpcResult<PinCheck> {
    only_from_settings(&window, PRIVACY)?;
    plausible_pin(&pin)?;
    let check = take_turn(&app, move |state, turn| {
        remove_pin(turn, state.db(), &state.new_pin_allowed, &pin, now_ms())
    })
    .await?;
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
    app: AppHandle,
    window: WebviewWindow,
    pin: String,
    method: RecoveryMethod,
) -> IpcResult<RecoveryChange> {
    only_from_settings(&window, PRIVACY)?;
    plausible_pin(&pin)?;
    method_usable(method, system_auth_available())?;
    take_turn(&app, move |state, turn| {
        change_recovery_method(turn, state.db(), &pin, method, now_ms())
    })
    .await
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

/// A check compares with the database lock released, so a lock may come while
/// it runs. `seen` is the lock count read before the check; the check's result
/// is acted on only if no lock came since. Called with the database lock held,
/// which every lock also takes.
fn no_lock_since(lock_epoch: &AtomicU64, seen: u64) -> bool {
    lock_epoch.load(Ordering::Acquire) == seen
}

/// Unlock after a correct PIN, unless a lock came during the check (`false`).
fn unlock_unless_locked_since(db: &Database, lock_epoch: &AtomicU64, seen: u64) -> bool {
    let unlock = no_lock_since(lock_epoch, seen);
    if unlock {
        db.set_privacy_locked(false, &[]);
    }
    unlock
}

/// The secret was right, but private notes locked while it was checked.
fn locked_meanwhile(what: &str) -> IpcError {
    IpcError::new(
        "not_allowed",
        format!("Private notes were locked again. Enter {what} again."),
    )
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
    let (check, accepted) = take_turn(&app, move |state, turn| {
        let seen = state.lock_epoch.load(Ordering::Acquire);
        check_then(
            turn,
            state.db(),
            Secret::RecoveryCode,
            &code,
            now_ms(),
            || Ok(()),
            |db, ()| {
                let accept = no_lock_since(&state.lock_epoch, seen);
                if accept {
                    accept_proof(db, state);
                }
                Ok(accept)
            },
        )
    })
    .await?;
    if accepted == Some(false) {
        return Err(locked_meanwhile("the recovery code"));
    }
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
    let result = take_turn(&app, move |state, _turn| {
        // No proof: refused before anything is hashed. The proof is checked
        // again, and used up, when the new PIN is stored.
        if !state.new_pin_allowed.load(Ordering::Acquire) {
            return Err(no_proof().into());
        }
        // The way back cannot change before the PIN is stored: changing it takes
        // a turn too.
        let method = state.with_db(|db| db.recovery_method())?;
        let pin = NewPin::new(&pin)?;
        let code = if issue_code_with_new_pin(method, system) {
            Some(NewRecoveryCode::new()?)
        } else {
            None
        };
        state.with_db(|db| replace_forgotten_pin(db, &state.new_pin_allowed, &pin, code))
    })
    .await;
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
    use std::sync::Mutex;
    use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

    use desknotes_core::db::{PinCheck, RecoveryChoice, RecoveryMethod, Secret};
    use desknotes_core::privacy::{NewPin, NewRecoveryCode};
    use desknotes_core::{CoreError, Database};

    use super::{
        RecoveryChange, Turn, change_known_pin, change_recovery_method, check_then,
        choose_new_pin_window, issue_code_with_new_pin, method_usable, needs_pin_first,
        plausible_pin, remove_pin, replace_forgotten_pin, store_first_pin, system_route_allowed,
        unlock_unless_locked_since, windows_must_hear,
    };
    use crate::state::SharedDb;

    fn with_turn<T>(f: impl FnOnce(&Turn) -> T) -> T {
        let secrets = Mutex::new(());
        f(&Turn {
            _guard: secrets.lock().unwrap(),
        })
    }

    fn shared_with_pin(pin: &str) -> SharedDb {
        let db = Database::open_in_memory().unwrap();
        db.set_new_pin(pin).unwrap();
        Mutex::new(Some(db))
    }

    fn peek<T>(db: &SharedDb, f: impl FnOnce(&Database) -> T) -> T {
        f(db.lock().unwrap().as_ref().unwrap())
    }

    fn new_pin(pin: &str) -> NewPin {
        NewPin::new(pin).unwrap()
    }

    fn new_code() -> Option<NewRecoveryCode> {
        Some(NewRecoveryCode::new().unwrap())
    }

    #[test]
    fn the_database_is_free_while_a_new_pin_is_hashed() {
        // Note windows keep saving while a PIN is checked and a new one made (DES-30).
        let db = shared_with_pin("482915");
        let (check, applied) = with_turn(|turn| {
            check_then(
                turn,
                &db,
                Secret::Pin,
                "482915",
                0,
                || {
                    assert!(db.try_lock().is_ok(), "the database lock is not held");
                    Ok(new_pin("730518"))
                },
                |db, pin| db.store_new_pin(&pin),
            )
        })
        .unwrap();
        assert_eq!((check, applied), (PinCheck::Ok, Some(())));
        assert_eq!(
            peek(&db, |d| d.check_pin("730518", 0).unwrap()),
            PinCheck::Ok
        );
    }

    #[test]
    fn a_lock_during_the_check_wins_over_the_unlock() {
        // The PIN is compared with the database lock released, so a lock (screen
        // lock, suspend, "Lock now") may come meanwhile; it must stay (DES-30).
        let db = shared_with_pin("482915");
        peek(&db, |d| d.set_privacy_locked(true, &[]));
        let epoch = AtomicU64::new(7);
        let unlock = |lock_comes: bool| {
            let seen = epoch.load(Ordering::SeqCst);
            with_turn(|turn| {
                check_then(
                    turn,
                    &db,
                    Secret::Pin,
                    "482915",
                    0,
                    || {
                        if lock_comes {
                            epoch.fetch_add(1, Ordering::SeqCst);
                        }
                        Ok(())
                    },
                    |d, ()| Ok(unlock_unless_locked_since(d, &epoch, seen)),
                )
            })
            .unwrap()
        };

        assert_eq!(unlock(true), (PinCheck::Ok, Some(false)));
        assert!(peek(&db, |d| d.privacy_locked()), "still locked");
        assert_eq!(unlock(false), (PinCheck::Ok, Some(true)));
        assert!(!peek(&db, |d| d.privacy_locked()));
    }

    #[test]
    fn a_wrong_or_waiting_check_prepares_and_applies_nothing() {
        let db = shared_with_pin("482915");
        let nothing = |_: &Database, ()| -> desknotes_core::CoreResult<()> {
            panic!("applied after a wrong PIN")
        };
        let (check, applied) = with_turn(|turn| {
            check_then(
                turn,
                &db,
                Secret::Pin,
                "000001",
                0,
                || -> desknotes_core::CoreResult<()> { panic!("prepared after a wrong PIN") },
                nothing,
            )
        })
        .unwrap();
        assert_eq!((check, applied), (PinCheck::Wrong { wait_secs: 0 }, None));

        // Four more failures start a wait; then even the right PIN is not compared.
        for _ in 0..4 {
            peek(&db, |d| d.check_pin("000001", 0).unwrap());
        }
        let (check, applied) = with_turn(|turn| {
            check_then(
                turn,
                &db,
                Secret::Pin,
                "482915",
                1_000,
                || -> desknotes_core::CoreResult<()> { panic!("prepared while waiting") },
                nothing,
            )
        })
        .unwrap();
        assert!(matches!(check, PinCheck::Waiting { .. }), "{check:?}");
        assert_eq!(applied, None);
    }

    #[test]
    fn changing_or_removing_the_pin_ends_a_forgotten_pin_proof() {
        // A proof given for the old PIN must not choose a PIN later (DES-30).
        let db = shared_with_pin("482915");
        let allowed = AtomicBool::new(true);
        assert!(matches!(
            with_turn(|turn| change_known_pin(turn, &db, &allowed, "000001", "730518", 0)).unwrap(),
            PinCheck::Wrong { .. }
        ));
        assert!(
            allowed.load(Ordering::SeqCst),
            "a wrong PIN changes nothing"
        );
        assert_eq!(
            with_turn(|turn| change_known_pin(turn, &db, &allowed, "482915", "730518", 0)).unwrap(),
            PinCheck::Ok
        );
        assert!(!allowed.load(Ordering::SeqCst));
        assert_eq!(
            peek(&db, |d| d.check_pin("730518", 0).unwrap()),
            PinCheck::Ok
        );

        allowed.store(true, Ordering::SeqCst);
        assert!(matches!(
            with_turn(|turn| remove_pin(turn, &db, &allowed, "000001", 0)).unwrap(),
            PinCheck::Wrong { .. }
        ));
        assert!(allowed.load(Ordering::SeqCst));
        assert!(peek(&db, |d| d.pin_is_set().unwrap()));
        assert_eq!(
            with_turn(|turn| remove_pin(turn, &db, &allowed, "730518", 0)).unwrap(),
            PinCheck::Ok
        );
        assert!(!allowed.load(Ordering::SeqCst));
        assert!(!peek(&db, |d| d.pin_is_set().unwrap()));
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
            replace_forgotten_pin(&db, &allowed, &new_pin("730518"), None).unwrap(),
            None
        );
        assert!(!db.has_recovery_code().unwrap());
        assert!(matches!(
            db.check_recovery_code(&old, 0).unwrap_err(),
            CoreError::NotAllowed(_)
        ));
        assert_eq!(db.check_pin("730518", 0).unwrap(), PinCheck::Ok);
        assert_eq!(
            db.recovery_method().unwrap(),
            Some(RecoveryMethod::System),
            "the way back is now stored, as Settings shows it"
        );
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

        let refused = replace_forgotten_pin(&db, &allowed, &new_pin("730518"), None).unwrap_err();
        assert!(matches!(refused, CoreError::NotAllowed(_)), "{refused:?}");
        assert_eq!(
            db.check_pin("482915", 0).unwrap(),
            PinCheck::Ok,
            "unchanged"
        );

        // After the Ubuntu password or a recovery code: one new PIN, once.
        allowed.store(true, Ordering::SeqCst);
        assert_eq!(
            replace_forgotten_pin(&db, &allowed, &new_pin("730518"), None).unwrap(),
            None
        );
        assert!(!allowed.load(Ordering::SeqCst), "the proof is used up");
        assert_eq!(db.check_pin("730518", 0).unwrap(), PinCheck::Ok);
        let again = replace_forgotten_pin(&db, &allowed, &new_pin("264093"), None).unwrap_err();
        assert!(matches!(again, CoreError::NotAllowed(_)), "{again:?}");
    }

    #[test]
    fn a_new_pin_comes_with_a_new_code_where_the_code_is_the_way_back() {
        let db = Database::open_in_memory().unwrap();
        db.set_new_pin("482915").unwrap();
        let old = db.issue_recovery_code().unwrap();
        let allowed = AtomicBool::new(true);

        let new = replace_forgotten_pin(&db, &allowed, &new_pin("730518"), new_code())
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
        let code = || RecoveryChoice::prepare(RecoveryMethod::Code).unwrap();
        let db = Database::open_in_memory().unwrap();
        assert_eq!(
            store_first_pin(&db, &new_pin("482915"), RecoveryChoice::System).unwrap(),
            None
        );
        assert_eq!(db.recovery_method().unwrap(), Some(RecoveryMethod::System));
        assert!(!db.has_recovery_code().unwrap());
        let again = store_first_pin(&db, &new_pin("730518"), code()).unwrap_err();
        assert!(matches!(again, CoreError::NotAllowed(_)), "{again:?}");
        assert_eq!(db.recovery_method().unwrap(), Some(RecoveryMethod::System));

        let db = Database::open_in_memory().unwrap();
        let shown = store_first_pin(&db, &new_pin("482915"), code())
            .unwrap()
            .expect("a recovery code");
        assert_eq!(db.recovery_method().unwrap(), Some(RecoveryMethod::Code));
        assert_eq!(db.check_recovery_code(&shown, 0).unwrap(), PinCheck::Ok);

        // A weak PIN is refused before anything is hashed or stored.
        let weak = NewPin::new("123456").err().expect("refused");
        assert_eq!(weak.code(), "validation");
    }

    #[test]
    fn changing_the_method_needs_the_pin_and_retires_the_old_code() {
        let db = shared_with_pin("482915");
        peek(&db, |d| {
            d.set_recovery_method(RecoveryMethod::System).unwrap()
        });

        // Wrong PIN: nothing changes, the wait counter grows.
        let wrong =
            with_turn(|turn| change_recovery_method(turn, &db, "000000", RecoveryMethod::Code, 0))
                .unwrap();
        assert_eq!(wrong.check, PinCheck::Wrong { wait_secs: 0 });
        assert_eq!(wrong.recovery_code, None);
        assert_eq!(
            peek(&db, |d| d.recovery_method().unwrap()),
            Some(RecoveryMethod::System)
        );
        assert!(!peek(&db, |d| d.has_recovery_code().unwrap()));

        // To a code: a new one, returned once.
        let to_code =
            with_turn(|turn| change_recovery_method(turn, &db, "482915", RecoveryMethod::Code, 0))
                .unwrap();
        assert_eq!(to_code.check, PinCheck::Ok);
        let code = to_code.recovery_code.expect("a recovery code");
        assert_eq!(
            peek(&db, |d| d.recovery_method().unwrap()),
            Some(RecoveryMethod::Code)
        );
        assert_eq!(
            peek(&db, |d| d.check_recovery_code(&code, 0).unwrap()),
            PinCheck::Ok
        );

        // Back to the computer password: the code stops working.
        let to_system = with_turn(|turn| {
            change_recovery_method(turn, &db, "482915", RecoveryMethod::System, 0)
        })
        .unwrap();
        assert_eq!(to_system.check, PinCheck::Ok);
        assert_eq!(to_system.recovery_code, None);
        assert_eq!(
            peek(&db, |d| d.recovery_method().unwrap()),
            Some(RecoveryMethod::System)
        );
        assert!(!peek(&db, |d| d.has_recovery_code().unwrap()));

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
