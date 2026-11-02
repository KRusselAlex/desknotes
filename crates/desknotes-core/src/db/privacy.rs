//! Storage for the privacy lock: PIN hash, recovery-code hash, wrong-PIN throttle,
//! the "PIN was reset" marker and the lock-after setting (design D6, D8, D11, §4.5-4.6).
//!
//! Callers authorise before changing anything here. PINs, hashes and codes are never
//! logged or put into error messages.

use serde::Serialize;

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
/// Unix ms of the last PIN reset by recovery code, until the owner acknowledges it.
pub const PIN_RESET_AT: &str = "pin_reset_at";
pub const LOCK_AFTER_MINUTES: &str = "lock_after_minutes";

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
        let code = new_recovery_code();
        let normalized = normalize_recovery_code(&code)
            .ok_or_else(|| CoreError::Validation("could not make a recovery code".into()))?;
        self.set_setting(PIN_RECOVERY_HASH, &hash_secret(&normalized)?)?;
        Ok(code)
    }

    pub fn has_recovery_code(&self) -> CoreResult<bool> {
        Ok(self.get_setting(PIN_RECOVERY_HASH)?.is_some())
    }

    /// Spacing, dashes and case do not matter. Shares the wrong-PIN throttle.
    pub fn check_recovery_code(&self, code: &str, now_ms: i64) -> CoreResult<PinCheck> {
        let normalized = normalize_recovery_code(code);
        self.check_secret(PIN_RECOVERY_HASH, normalized.as_deref(), now_ms)
    }

    /// Removes the PIN, recovery code and wait. Private flags and labels stay.
    pub fn clear_pin(&self) -> CoreResult<()> {
        self.conn.execute(
            "DELETE FROM settings WHERE key IN (?1, ?2, ?3)",
            [PIN_HASH, PIN_RECOVERY_HASH, PIN_THROTTLE],
        )?;
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
