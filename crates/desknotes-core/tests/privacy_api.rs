//! Locks in that the privacy-lock types the Tauri commands need are public.

use desknotes_core::db::{LOCK_AFTER_CHOICES, PinCheck};

#[test]
fn pin_check_and_lock_after_choices_are_public() {
    assert_eq!(LOCK_AFTER_CHOICES, [1, 5, 10, 15]);
    let check: PinCheck = PinCheck::Wrong { wait_secs: 30 };
    assert_eq!(
        serde_json::to_string(&check).unwrap(),
        r#"{"kind":"wrong","waitSecs":30}"#
    );
}
