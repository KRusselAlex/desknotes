//! Pure privacy-lock rules: PIN policy, Argon2id hashing, recovery codes and the
//! wrong-PIN throttle (design D4, D6, D8, D9; §4.5).
//!
//! Nothing here touches the database or the clock; callers pass `now_ms` in. PINs,
//! hashes and codes are never logged or put into error messages.

use argon2::{
    Algorithm, Argon2, Params, PasswordHasher, PasswordVerifier, Version, password_hash,
    password_hash::phc::PasswordHash,
};
use serde::{Deserialize, Serialize};

use crate::{CoreError, CoreResult};

/// Length of a PIN: exactly this many ASCII digits.
pub const PIN_DIGITS: usize = 6;

/// Characters a recovery code is drawn from: no `0`, `1`, `I` or `O`.
const RECOVERY_ALPHABET: &[u8; 32] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const RECOVERY_LEN: usize = 24;

// Argon2id cost: m = 64 MiB, t = 4 passes, p = 1 lane. Measured on 2026-11-02 on the
// owner's laptop (Intel Meteor Lake) in a release build (`cargo test --release`):
// about 0.33 s per hash (5-run mean; m=64 MiB t=3 gave 0.27 s, m=128 MiB t=3 0.54 s).
// Target is 0.3-0.5 s. Re-tune if hashing gets noticeably faster or slower.
const ARGON2_M_COST_KIB: u32 = 65_536;
const ARGON2_T_COST: u32 = 4;
const ARGON2_P_COST: u32 = 1;

fn hasher() -> CoreResult<Argon2<'static>> {
    let params = Params::new(ARGON2_M_COST_KIB, ARGON2_T_COST, ARGON2_P_COST, None)
        .map_err(|_| CoreError::Internal("invalid hashing parameters".into()))?;
    Ok(Argon2::new(Algorithm::Argon2id, Version::V0x13, params))
}

fn bad_pin() -> CoreError {
    CoreError::Validation(format!(
        "PIN must be {PIN_DIGITS} digits and not obvious (such as 000000 or 123456)"
    ))
}

/// Accepts exactly six ASCII digits that are not all equal and not an ascending or
/// descending run (each digit the previous one plus or minus one).
pub fn validate_new_pin(pin: &str) -> CoreResult<()> {
    // Check length and character class first, so arithmetic only sees ASCII digits.
    if pin.len() != PIN_DIGITS || !pin.bytes().all(|b| b.is_ascii_digit()) {
        return Err(bad_pin());
    }
    let digits: Vec<u8> = pin.bytes().map(|b| b - b'0').collect();
    if digits.windows(2).all(|w| w[1] == w[0]) {
        return Err(bad_pin());
    }
    if digits.windows(2).all(|w| w[1] == w[0] + 1) || digits.windows(2).all(|w| w[0] == w[1] + 1) {
        return Err(bad_pin());
    }
    Ok(())
}

/// Hashes a PIN or recovery code to an Argon2id PHC string with a fresh random salt
/// from the operating system's RNG.
pub fn hash_secret(secret: &str) -> CoreResult<String> {
    let salt = password_hash::try_generate_salt().map_err(|_| no_random_source())?;
    let hash = hasher()?
        .hash_password_with_salt(secret.as_bytes(), &salt)
        .map_err(|_| CoreError::Internal("could not hash secret".into()))?;
    Ok(hash.to_string())
}

/// Checks `secret` against a PHC string; `false` for a wrong secret or malformed hash.
pub fn verify_secret(phc: &str, secret: &str) -> bool {
    match PasswordHash::new(phc) {
        Ok(parsed) => hasher()
            .map(|h| h.verify_password(secret.as_bytes(), &parsed).is_ok())
            .unwrap_or(false),
        Err(_) => false,
    }
}

fn no_random_source() -> CoreError {
    CoreError::Internal("no secure random source available".into())
}

/// A new random recovery code: 24 characters in six dash-separated groups of four.
/// Fails, rather than panicking, when the OS random source does.
pub fn new_recovery_code() -> CoreResult<String> {
    // 24 bytes from the OS RNG (two 16-byte draws); the low five bits of each byte pick
    // one of 32 characters, which is unbiased because 32 divides 256.
    let mut bytes = [0u8; 32];
    for chunk in bytes.chunks_mut(16) {
        let draw = password_hash::try_generate_salt().map_err(|_| no_random_source())?;
        chunk.copy_from_slice(&draw);
    }
    let mut code = String::with_capacity(RECOVERY_LEN + 5);
    for (i, b) in bytes[..RECOVERY_LEN].iter().enumerate() {
        if i > 0 && i % 4 == 0 {
            code.push('-');
        }
        code.push(RECOVERY_ALPHABET[(b & 31) as usize] as char);
    }
    Ok(code)
}

/// Strips spaces and dashes, uppercases, and returns the bare 24 characters, or `None`
/// if the input is not a well-formed recovery code.
pub fn normalize_recovery_code(input: &str) -> Option<String> {
    let cleaned: String = input
        .chars()
        .filter(|c| *c != ' ' && *c != '-')
        .map(|c| c.to_ascii_uppercase())
        .collect();
    let ok =
        cleaned.len() == RECOVERY_LEN && cleaned.bytes().all(|b| RECOVERY_ALPHABET.contains(&b));
    ok.then_some(cleaned)
}

/// Wrong-PIN throttle state. Persisted by the caller; time is passed in as Unix ms.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Throttle {
    pub failures: u32,
    pub wait_until_ms: i64,
}

impl Throttle {
    /// Seconds to wait after the given number of consecutive failures:
    /// 1-4 none, 5th 30 s, 6th 60 s, 7th and later 300 s.
    fn step_secs(failures: u32) -> u64 {
        match failures {
            0..=4 => 0,
            5 => 30,
            6 => 60,
            _ => 300,
        }
    }

    pub fn record_failure(&mut self, now_ms: i64) {
        self.failures = self.failures.saturating_add(1);
        let wait_ms = Self::step_secs(self.failures) as i64 * 1000;
        self.wait_until_ms = if wait_ms > 0 {
            now_ms.saturating_add(wait_ms)
        } else {
            0
        };
    }

    /// Whole seconds still to wait (rounded up). Never more than the current step, so a
    /// clock moved backwards cannot lock the owner out for longer than the schedule says.
    pub fn remaining_secs(&self, now_ms: i64) -> u64 {
        let left_ms = self.wait_until_ms.saturating_sub(now_ms);
        if left_ms <= 0 {
            return 0;
        }
        let left = (left_ms as u64).div_ceil(1000);
        left.min(Self::step_secs(self.failures))
    }

    pub fn reset(&mut self) {
        *self = Self::default();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_six_digit_pins() {
        assert!(validate_new_pin("482915").is_ok());
    }

    #[test]
    fn refuses_weak_or_malformed_pins() {
        for pin in [
            "12345",
            "1234567",
            "12a456",
            "000000",
            "123456",
            "654321",
            "345678",
            // Non-ASCII input must be refused, never panic.
            "12€456",
            "１２３４５６",
            "12345€",
            "€€€€€€",
            "",
        ] {
            let err = validate_new_pin(pin).expect_err(pin);
            assert_eq!(err.code(), "validation", "{pin}");
        }
    }

    #[test]
    fn hash_then_verify() {
        let a = hash_secret("482915").unwrap();
        assert!(a.starts_with("$argon2id$"));
        assert!(verify_secret(&a, "482915"));
        assert!(!verify_secret(&a, "482916"));
        assert!(!verify_secret("junk", "482915"));
        let b = hash_secret("482915").unwrap();
        assert_ne!(a, b);
    }

    #[test]
    fn recovery_code_shape() {
        let shape = |c: &str| {
            c.len() == 29
                && c.split('-').count() == 6
                && c.split('-')
                    .all(|g| g.len() == 4 && g.bytes().all(|b| RECOVERY_ALPHABET.contains(&b)))
        };
        let codes: std::collections::HashSet<String> =
            (0..100).map(|_| new_recovery_code().unwrap()).collect();
        assert_eq!(codes.len(), 100);
        assert!(codes.iter().all(|c| shape(c)));
    }

    #[test]
    fn recovery_code_normalizes() {
        assert_eq!(
            normalize_recovery_code(" k7qd m2xr-9fpa wt4h c8nb zl6e ").as_deref(),
            Some("K7QDM2XR9FPAWT4HC8NBZL6E")
        );
        assert_eq!(normalize_recovery_code("K7QDM2XR9FPAWT4HC8NBZL6"), None);
        assert_eq!(normalize_recovery_code("O7QDM2XR9FPAWT4HC8NBZL6E"), None);
        let fresh = new_recovery_code().unwrap();
        assert_eq!(normalize_recovery_code(&fresh).unwrap().len(), 24);
    }

    #[test]
    fn throttle_schedule() {
        let mut t = Throttle::default();
        let now = 1_000_000;
        for _ in 0..4 {
            t.record_failure(now);
            assert_eq!(t.remaining_secs(now), 0);
        }
        t.record_failure(now);
        assert_eq!(t.remaining_secs(now), 30);
        assert_eq!(t.remaining_secs(now + 10_000), 20);
        assert_eq!(t.remaining_secs(now + 30_000), 0);
        t.record_failure(now);
        assert_eq!(t.remaining_secs(now), 60);
        t.record_failure(now);
        assert_eq!(t.remaining_secs(now), 300);
        t.record_failure(now);
        t.record_failure(now);
        assert_eq!(t.failures, 9);
        assert_eq!(t.remaining_secs(now), 300);
        t.reset();
        assert_eq!(t, Throttle::default());
    }

    #[test]
    fn throttle_clock_moved_back() {
        let now = 10_000_000_000;
        let t = Throttle {
            failures: 7,
            wait_until_ms: now + 300_000,
        };
        let earlier = now - 2 * 3_600_000;
        assert_eq!(t.remaining_secs(earlier), 300);
        assert_eq!(t.remaining_secs(now), 300);
    }
}
