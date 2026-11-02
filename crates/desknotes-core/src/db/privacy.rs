//! Storage for the privacy lock: PIN hash, recovery-code hash, wrong-PIN throttle,
//! the "PIN was reset" marker, the lock-after setting and how a forgotten PIN is
//! replaced (design D6, D8, D11, D14, §4.5-4.6).
//!
//! Callers authorise before changing anything here. PINs, hashes and codes are never
//! logged or put into error messages.

use serde::{Deserialize, Serialize};

use super::Database;
use crate::error::{CoreError, CoreResult};
use crate::privacy::{
    Throttle, hash_secret, new_recovery_code, normalize_recovery_code, validate_new_pin,
    verify_secret,
};

/// Settings keys. Values are stored as text.
pub const PIN_HASH: &str = "pin_hash";
pub const PIN_RECOVERY_HASH: &str = "pin_recovery_hash";
/// JSON `{"failures": .., "wait_until_ms": ..}`, shared by PIN and recovery-code checks.
pub const PIN_THROTTLE: &str = "pin_throttle";
/// Unix ms of the last `desknotes --reset-pin` (D11), until the owner acknowledges it.
pub const PIN_RESET_AT: &str = "pin_reset_at";
pub const LOCK_AFTER_MINUTES: &str = "lock_after_minutes";
/// "system" or "code" (design D14). Missing for PINs set before D14.
pub const RECOVERY_METHOD: &str = "recovery_method";

/// Minutes of inactivity offered for auto-lock; the first is not special.
pub const LOCK_AFTER_CHOICES: [u32; 4] = [1, 5, 10, 15];
const DEFAULT_LOCK_AFTER: u32 = 5;

/// Outcome of checking a PIN or recovery code.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum PinCheck {
    Ok,
    /// Wrong secret; `wait_secs` is the wait this failure started (0 for none).
    Wrong {
        wait_secs: u64,
    },
    /// A wait is still running; the secret was not even checked.
    Waiting {
        wait_secs: u64,
    },
}

/// How a forgotten PIN is replaced, as chosen by the owner (design D14): the
/// computer's own password (polkit, D5) or a recovery code (D6).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RecoveryMethod {
    System,
    Code,
}

impl RecoveryMethod {
    fn as_str(self) -> &'static str {
        match self {
            Self::System => "system",
            Self::Code => "code",
        }
    }

    fn parse(raw: &str) -> Option<Self> {
        match raw {
            "system" => Some(Self::System),
            "code" => Some(Self::Code),
            _ => None,
        }
    }
}

/// A new recovery code (dashed, shown once) and the hash of its normalized form.
fn make_recovery_code() -> CoreResult<(String, String)> {
    let code = new_recovery_code();
    let normalized = normalize_recovery_code(&code)
        .ok_or_else(|| CoreError::Validation("could not make a recovery code".into()))?;
    Ok((code, hash_secret(&normalized)?))
}

impl Database {
    fn delete_setting(&self, key: &str) -> CoreResult<()> {
        self.conn
            .execute("DELETE FROM settings WHERE key = ?1", [key])?;
        Ok(())
    }

    /// Stored throttle; a missing or damaged value counts as no failures.
    fn throttle(&self) -> CoreResult<Throttle> {
        Ok(self
            .get_setting(PIN_THROTTLE)?
            .and_then(|raw| serde_json::from_str(&raw).ok())
            .unwrap_or_default())
    }

    fn save_throttle(&self, throttle: &Throttle) -> CoreResult<()> {
        let json = serde_json::to_string(throttle)
            .map_err(|_| CoreError::Validation("could not store the wait".into()))?;
        self.set_setting(PIN_THROTTLE, &json)
    }

    /// Shared by PIN and recovery-code checks. `candidate` is `None` for input that
    /// cannot be right (it still counts as a failed try, without hashing).
    fn check_secret(
        &self,
        hash_key: &str,
        candidate: Option<&str>,
        now_ms: i64,
    ) -> CoreResult<PinCheck> {
        let Some(hash) = self.get_setting(hash_key)? else {
            return Err(CoreError::NotAllowed("nothing is set to check".into()));
        };
        let mut throttle = self.throttle()?;
        let wait = throttle.remaining_secs(now_ms);
        if wait > 0 {
            return Ok(PinCheck::Waiting { wait_secs: wait });
        }
        if candidate.is_some_and(|c| verify_secret(&hash, c)) {
            if throttle != Throttle::default() {
                self.delete_setting(PIN_THROTTLE)?;
            }
            return Ok(PinCheck::Ok);
        }
        throttle.record_failure(now_ms);
        self.save_throttle(&throttle)?;
        Ok(PinCheck::Wrong {
            wait_secs: throttle.remaining_secs(now_ms),
        })
    }

    pub fn pin_is_set(&self) -> CoreResult<bool> {
        Ok(self.get_setting(PIN_HASH)?.is_some())
    }

    /// Validates and stores a new PIN and clears any wait.
    pub fn set_new_pin(&self, pin: &str) -> CoreResult<()> {
        validate_new_pin(pin)?;
        let hash = hash_secret(pin)?;
        let tx = self.conn.unchecked_transaction()?;
        self.set_setting(PIN_HASH, &hash)?;
        self.delete_setting(PIN_THROTTLE)?;
        tx.commit()?;
        Ok(())
    }

    pub fn check_pin(&self, pin: &str, now_ms: i64) -> CoreResult<PinCheck> {
        self.check_secret(PIN_HASH, Some(pin), now_ms)
    }

    /// Makes a new recovery code, replacing any earlier one. The code is returned
    /// (dashed) once; only the hash of its normalized form is stored.
    pub fn issue_recovery_code(&self) -> CoreResult<String> {
        let (code, hash) = make_recovery_code()?;
        self.set_setting(PIN_RECOVERY_HASH, &hash)?;
        Ok(code)
    }

    pub fn has_recovery_code(&self) -> CoreResult<bool> {
        Ok(self.get_setting(PIN_RECOVERY_HASH)?.is_some())
    }

    /// Removes only the recovery code, so it stops working (D14: the owner chose
    /// the computer password instead). The PIN, method and wait are kept.
    pub fn clear_recovery_code(&self) -> CoreResult<()> {
        self.delete_setting(PIN_RECOVERY_HASH)
    }

    /// The chosen way back; `None` when never chosen (PINs set before D14) or damaged.
    pub fn recovery_method(&self) -> CoreResult<Option<RecoveryMethod>> {
        Ok(self
            .get_setting(RECOVERY_METHOD)?
            .and_then(|raw| RecoveryMethod::parse(&raw)))
    }

    /// Callers check the PIN and that the method can be used here first.
    pub fn set_recovery_method(&self, method: RecoveryMethod) -> CoreResult<()> {
        self.set_setting(RECOVERY_METHOD, method.as_str())
    }

    /// Changes the way back in one transaction (D14): to `Code`, a new recovery
    /// code replaces any earlier one and is returned (dashed) once; to `System`,
    /// the stored code is removed so it stops working. On error nothing changed.
    /// Callers check the PIN and that the method can be used here first.
    pub fn switch_recovery_method(&self, method: RecoveryMethod) -> CoreResult<Option<String>> {
        // Hashing is slow: done before the transaction opens.
        let issued = match method {
            RecoveryMethod::Code => Some(make_recovery_code()?),
            RecoveryMethod::System => None,
        };
        let tx = self.conn.unchecked_transaction()?;
        match &issued {
            Some((_, hash)) => self.set_setting(PIN_RECOVERY_HASH, hash)?,
            None => self.delete_setting(PIN_RECOVERY_HASH)?,
        }
        self.set_recovery_method(method)?;
        tx.commit()?;
        Ok(issued.map(|(code, _)| code))
    }

    /// Spacing, dashes and case do not matter. Shares the wrong-PIN throttle.
    pub fn check_recovery_code(&self, code: &str, now_ms: i64) -> CoreResult<PinCheck> {
        let normalized = normalize_recovery_code(code);
        self.check_secret(PIN_RECOVERY_HASH, normalized.as_deref(), now_ms)
    }

    /// Removes the PIN, recovery code, recovery method and wait. Private flags and
    /// labels stay.
    /// The privacy lock is turned off too, so a PIN set later does not suddenly
    /// lock notes whose editors are open; the shell locks again explicitly.
    pub fn clear_pin(&self) -> CoreResult<()> {
        self.conn.execute(
            "DELETE FROM settings WHERE key IN (?1, ?2, ?3, ?4)",
            [PIN_HASH, PIN_RECOVERY_HASH, PIN_THROTTLE, RECOVERY_METHOD],
        )?;
        self.set_privacy_locked(false, &[]);
        Ok(())
    }

    pub fn record_pin_reset(&self, now_ms: i64) -> CoreResult<()> {
        self.set_setting(PIN_RESET_AT, &now_ms.to_string())
    }

    /// When the PIN was reset by recovery code, until acknowledged. Damaged → `None`.
    pub fn pin_reset_at(&self) -> CoreResult<Option<i64>> {
        Ok(self
            .get_setting(PIN_RESET_AT)?
            .and_then(|raw| raw.parse().ok()))
    }

    pub fn acknowledge_pin_reset(&self) -> CoreResult<()> {
        self.delete_setting(PIN_RESET_AT)
    }

    /// Minutes of inactivity before private notes lock; a missing, damaged or
    /// unoffered stored value gives 5.
    pub fn lock_after_minutes(&self) -> CoreResult<u32> {
        Ok(self
            .get_setting(LOCK_AFTER_MINUTES)?
            .and_then(|raw| raw.parse::<u32>().ok())
            .filter(|m| LOCK_AFTER_CHOICES.contains(m))
            .unwrap_or(DEFAULT_LOCK_AFTER))
    }

    pub fn set_lock_after_minutes(&self, minutes: u32) -> CoreResult<()> {
        if !LOCK_AFTER_CHOICES.contains(&minutes) {
            return Err(CoreError::Validation(
                "lock after must be 1, 5, 10 or 15 minutes".into(),
            ));
        }
        self.set_setting(LOCK_AFTER_MINUTES, &minutes.to_string())
    }
}

#[cfg(test)]
mod tests {
    use std::sync::OnceLock;

    use super::*;

    const PIN: &str = "482915";
    const NOW: i64 = 1_000_000_000;

    // Argon2 is slow in debug builds, so shared hashes are made once per test run and
    // installed straight into the settings table where a test is not about hashing.
    fn pin_hash() -> &'static str {
        static H: OnceLock<String> = OnceLock::new();
        H.get_or_init(|| hash_secret(PIN).unwrap())
    }

    fn recovery() -> &'static (String, String) {
        static R: OnceLock<(String, String)> = OnceLock::new();
        R.get_or_init(|| {
            let code = new_recovery_code();
            let hash = hash_secret(&normalize_recovery_code(&code).unwrap()).unwrap();
            (code, hash)
        })
    }

    fn throttle_of(db: &Database) -> Throttle {
        serde_json::from_str(&db.get_setting(PIN_THROTTLE).unwrap().unwrap()).unwrap()
    }

    #[test]
    fn pin_set_check_and_wrong() {
        let db = Database::open_in_memory().unwrap();
        assert!(!db.pin_is_set().unwrap());
        assert_eq!(db.check_pin(PIN, NOW).unwrap_err().code(), "not_allowed");
        assert_eq!(db.set_new_pin("123456").unwrap_err().code(), "validation");
        assert!(!db.pin_is_set().unwrap());

        db.set_new_pin(PIN).unwrap();
        assert!(db.pin_is_set().unwrap());
        let stored = db.get_setting(PIN_HASH).unwrap().unwrap();
        assert!(stored.starts_with("$argon2id$") && !stored.contains(PIN));

        assert_eq!(
            db.check_pin("482916", NOW).unwrap(),
            PinCheck::Wrong { wait_secs: 0 }
        );
        assert_eq!(throttle_of(&db).failures, 1);
        assert_eq!(db.check_pin(PIN, NOW).unwrap(), PinCheck::Ok);
        assert_eq!(db.get_setting(PIN_THROTTLE).unwrap(), None);

        // The wire format the UI reads.
        assert_eq!(
            serde_json::to_string(&PinCheck::Wrong { wait_secs: 30 }).unwrap(),
            r#"{"kind":"wrong","waitSecs":30}"#
        );
        assert_eq!(
            serde_json::to_string(&PinCheck::Waiting { wait_secs: 5 }).unwrap(),
            r#"{"kind":"waiting","waitSecs":5}"#
        );
        assert_eq!(
            serde_json::to_string(&PinCheck::Ok).unwrap(),
            r#"{"kind":"ok"}"#
        );
    }

    #[test]
    fn wait_survives_reopening_the_database() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("d.db");
        let backups = dir.path().join("backups");
        {
            let db = Database::open(&path, &backups).unwrap();
            db.set_setting(PIN_HASH, pin_hash()).unwrap();
            // Four failures already on record (shortcut: hashing four wrong PINs in a
            // debug build takes ~16 s); the fifth goes through the real check.
            db.save_throttle(&Throttle {
                failures: 4,
                wait_until_ms: 0,
            })
            .unwrap();
            assert_eq!(
                db.check_pin("000001", NOW).unwrap(),
                PinCheck::Wrong { wait_secs: 30 }
            );
        }
        let db = Database::open(&path, &backups).unwrap();
        // Even the right PIN is not looked at while the wait runs.
        assert_eq!(
            db.check_pin(PIN, NOW + 10_000).unwrap(),
            PinCheck::Waiting { wait_secs: 20 }
        );
        assert_eq!(db.check_pin(PIN, NOW + 31_000).unwrap(), PinCheck::Ok);
    }

    #[test]
    fn recovery_code_checks_normalized_input_and_shares_the_throttle() {
        let db = Database::open_in_memory().unwrap();
        assert!(!db.has_recovery_code().unwrap());
        assert_eq!(
            db.check_recovery_code("x", NOW).unwrap_err().code(),
            "not_allowed"
        );

        let (code, hash) = recovery();
        db.set_setting(PIN_RECOVERY_HASH, hash).unwrap();
        assert!(db.has_recovery_code().unwrap());

        // Malformed input fails without hashing but still counts as a try.
        assert_eq!(
            db.check_recovery_code("too short", NOW).unwrap(),
            PinCheck::Wrong { wait_secs: 0 }
        );
        assert_eq!(throttle_of(&db).failures, 1);

        let sloppy = code.replace('-', " ").to_lowercase();
        assert_eq!(db.check_recovery_code(&sloppy, NOW).unwrap(), PinCheck::Ok);
        assert_eq!(db.get_setting(PIN_THROTTLE).unwrap(), None);

        // The same throttle applies to codes and PINs: a wait started here blocks both.
        db.save_throttle(&Throttle {
            failures: 4,
            wait_until_ms: 0,
        })
        .unwrap();
        assert_eq!(
            db.check_recovery_code("too short", NOW).unwrap(),
            PinCheck::Wrong { wait_secs: 30 }
        );
        assert_eq!(
            db.check_recovery_code(code, NOW + 1_000).unwrap(),
            PinCheck::Waiting { wait_secs: 29 }
        );
        db.set_setting(PIN_HASH, pin_hash()).unwrap();
        assert_eq!(
            db.check_pin(PIN, NOW + 1_000).unwrap(),
            PinCheck::Waiting { wait_secs: 29 }
        );
    }

    #[test]
    fn issued_recovery_code_stores_only_the_normalized_hash() {
        let db = Database::open_in_memory().unwrap();
        let code = db.issue_recovery_code().unwrap();
        let stored = db.get_setting(PIN_RECOVERY_HASH).unwrap().unwrap();
        assert!(stored.starts_with("$argon2id$"));
        assert!(!stored.contains(&code.replace('-', "")));
        let normalized = normalize_recovery_code(&code).unwrap();
        assert!(verify_secret(&stored, &normalized));
    }

    #[test]
    fn clear_pin_keeps_private_notes() {
        let db = Database::open_in_memory().unwrap();
        let id = db.create_note(None).unwrap().id;
        db.set_private(&id, true, "Work").unwrap();
        db.set_setting(PIN_HASH, pin_hash()).unwrap();
        db.set_setting(PIN_RECOVERY_HASH, &recovery().1).unwrap();
        db.save_throttle(&Throttle {
            failures: 6,
            wait_until_ms: NOW,
        })
        .unwrap();

        db.clear_pin().unwrap();
        assert!(!db.pin_is_set().unwrap());
        assert!(!db.has_recovery_code().unwrap());
        assert_eq!(db.get_setting(PIN_THROTTLE).unwrap(), None);
        let note = db.get_note(&id).unwrap();
        assert!(note.private);
        assert_eq!(note.private_label, "Work");
    }

    #[test]
    fn recovery_method_round_trips_and_damaged_reads_none() {
        let db = Database::open_in_memory().unwrap();
        assert_eq!(db.recovery_method().unwrap(), None);
        db.set_recovery_method(RecoveryMethod::Code).unwrap();
        assert_eq!(
            db.get_setting(RECOVERY_METHOD).unwrap().as_deref(),
            Some("code")
        );
        assert_eq!(db.recovery_method().unwrap(), Some(RecoveryMethod::Code));
        db.set_recovery_method(RecoveryMethod::System).unwrap();
        assert_eq!(
            db.get_setting(RECOVERY_METHOD).unwrap().as_deref(),
            Some("system")
        );
        assert_eq!(db.recovery_method().unwrap(), Some(RecoveryMethod::System));
        for raw in ["", "junk", "System", "CODE", " code"] {
            db.set_setting(RECOVERY_METHOD, raw).unwrap();
            assert_eq!(db.recovery_method().unwrap(), None, "{raw:?}");
        }

        // The wire format the UI reads and sends.
        assert_eq!(
            serde_json::to_string(&Some(RecoveryMethod::System)).unwrap(),
            r#""system""#
        );
        assert_eq!(
            serde_json::to_string(&None::<RecoveryMethod>).unwrap(),
            "null"
        );
        assert_eq!(
            serde_json::from_str::<RecoveryMethod>(r#""code""#).unwrap(),
            RecoveryMethod::Code
        );
        assert!(serde_json::from_str::<RecoveryMethod>(r#""none""#).is_err());
    }

    #[test]
    fn clear_recovery_code_removes_only_the_code() {
        let db = Database::open_in_memory().unwrap();
        db.set_setting(PIN_HASH, pin_hash()).unwrap();
        db.set_setting(PIN_RECOVERY_HASH, &recovery().1).unwrap();
        db.set_recovery_method(RecoveryMethod::System).unwrap();
        db.save_throttle(&Throttle {
            failures: 2,
            wait_until_ms: 0,
        })
        .unwrap();

        db.clear_recovery_code().unwrap();
        assert!(!db.has_recovery_code().unwrap());
        assert!(db.pin_is_set().unwrap());
        assert_eq!(db.recovery_method().unwrap(), Some(RecoveryMethod::System));
        assert_eq!(throttle_of(&db).failures, 2);
        assert_eq!(
            db.check_recovery_code(&recovery().0, NOW)
                .unwrap_err()
                .code(),
            "not_allowed",
            "the old code no longer works"
        );
        // Nothing to clear is fine.
        db.clear_recovery_code().unwrap();
    }

    #[test]
    fn switching_to_code_stores_a_new_code_and_the_method_together() {
        let db = Database::open_in_memory().unwrap();
        db.set_setting(PIN_HASH, pin_hash()).unwrap();
        db.set_setting(PIN_RECOVERY_HASH, &recovery().1).unwrap();
        db.set_recovery_method(RecoveryMethod::System).unwrap();

        let code = db
            .switch_recovery_method(RecoveryMethod::Code)
            .unwrap()
            .expect("a recovery code");
        assert_eq!(db.recovery_method().unwrap(), Some(RecoveryMethod::Code));
        assert_eq!(db.check_recovery_code(&code, NOW).unwrap(), PinCheck::Ok);
        assert!(matches!(
            db.check_recovery_code(&recovery().0, NOW).unwrap(),
            PinCheck::Wrong { .. }
        ));
        let stored = db.get_setting(PIN_RECOVERY_HASH).unwrap().unwrap();
        assert!(!stored.contains(&code.replace('-', "")));
    }

    #[test]
    fn switching_to_system_removes_the_code_with_the_method() {
        let db = Database::open_in_memory().unwrap();
        db.set_setting(PIN_HASH, pin_hash()).unwrap();
        db.set_setting(PIN_RECOVERY_HASH, &recovery().1).unwrap();
        db.set_recovery_method(RecoveryMethod::Code).unwrap();

        assert_eq!(
            db.switch_recovery_method(RecoveryMethod::System).unwrap(),
            None
        );
        assert_eq!(db.recovery_method().unwrap(), Some(RecoveryMethod::System));
        assert!(!db.has_recovery_code().unwrap());
        assert!(db.pin_is_set().unwrap());
    }

    #[test]
    fn a_failed_switch_changes_nothing() {
        let db = Database::open_in_memory().unwrap();
        db.set_setting(PIN_HASH, pin_hash()).unwrap();
        db.set_setting(PIN_RECOVERY_HASH, &recovery().1).unwrap();
        db.set_recovery_method(RecoveryMethod::Code).unwrap();
        // Make the method write (the second one) fail inside the transaction.
        db.conn
            .execute_batch(
                "CREATE TEMP TRIGGER refuse_method BEFORE UPDATE ON settings \
                 WHEN NEW.key = 'recovery_method' BEGIN SELECT RAISE(ABORT, 'no'); END;",
            )
            .unwrap();

        assert!(db.switch_recovery_method(RecoveryMethod::System).is_err());
        assert_eq!(db.recovery_method().unwrap(), Some(RecoveryMethod::Code));
        assert_eq!(
            db.check_recovery_code(&recovery().0, NOW).unwrap(),
            PinCheck::Ok,
            "the old code still works"
        );

        assert!(db.switch_recovery_method(RecoveryMethod::Code).is_err());
        assert_eq!(
            db.check_recovery_code(&recovery().0, NOW).unwrap(),
            PinCheck::Ok,
            "not replaced by a code never shown"
        );
    }

    #[test]
    fn clear_pin_forgets_the_method() {
        let db = Database::open_in_memory().unwrap();
        db.set_setting(PIN_HASH, pin_hash()).unwrap();
        db.set_recovery_method(RecoveryMethod::Code).unwrap();
        db.clear_pin().unwrap();
        assert_eq!(db.recovery_method().unwrap(), None);
        assert_eq!(db.get_setting(RECOVERY_METHOD).unwrap(), None);
    }

    #[test]
    fn lock_after_accepts_only_offered_values() {
        let db = Database::open_in_memory().unwrap();
        assert_eq!(db.lock_after_minutes().unwrap(), 5);
        for m in [1, 5, 10, 15] {
            db.set_lock_after_minutes(m).unwrap();
            assert_eq!(db.lock_after_minutes().unwrap(), m);
        }
        db.set_lock_after_minutes(10).unwrap();
        for m in [0, 2, 7, 60] {
            assert_eq!(
                db.set_lock_after_minutes(m).unwrap_err().code(),
                "validation"
            );
        }
        assert_eq!(db.lock_after_minutes().unwrap(), 10);
        for raw in ["junk", "7", "-5", ""] {
            db.set_setting(LOCK_AFTER_MINUTES, raw).unwrap();
            assert_eq!(db.lock_after_minutes().unwrap(), 5, "{raw}");
        }
    }

    #[test]
    fn pin_reset_banner_round_trip() {
        let db = Database::open_in_memory().unwrap();
        assert_eq!(db.pin_reset_at().unwrap(), None);
        db.record_pin_reset(NOW).unwrap();
        assert_eq!(db.pin_reset_at().unwrap(), Some(NOW));
        db.acknowledge_pin_reset().unwrap();
        assert_eq!(db.pin_reset_at().unwrap(), None);
        db.set_setting(PIN_RESET_AT, "junk").unwrap();
        assert_eq!(db.pin_reset_at().unwrap(), None);
    }
}
