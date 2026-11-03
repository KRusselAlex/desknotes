# Privacy Lock for Private Notes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Notes marked private hide their text behind a 6-digit PIN until unlocked, with the
Ubuntu password (or a recovery code) as the way back from a forgotten PIN.

**Architecture:** Enforcement lives in the core: `Database` carries an in-memory lock flag,
and while it is set every read redacts private notes and every destructive or copying write
on them is refused, so no window can obtain locked text whatever it asks. PIN hashing,
PIN rules, recovery codes and the wrong-PIN throttle are pure functions in a new core module,
stored in the settings table. The shell decides *when* to lock (sleep, screen lock,
inactivity, "Lock now"), saves first, and handles the forgotten-PIN routes (polkit,
recovery code, `--reset-pin`). The webview only renders: a locked note never mounts the editor.

**Tech Stack:** Rust (rusqlite, `argon2` 0.6, `zbus` 5.13.2 blocking API already in the build),
Tauri 2, React/TypeScript, Vitest + Testing Library.

**Spec:** `docs/superpowers/specs/2026-11-02-privacy-lock-design.md` (decisions D1–D13).

## Global Constraints

- Only notes marked private lock (D1). One PIN unlocks all of them until the next lock (D7).
- PIN is exactly 6 digits (D4); refuse all-same-digit and straight runs up or down (D9).
- A locked private note exposes only its colour and its label; empty label → `Private note` (D2). Never its title, snippet or content.
- Wrong-PIN waits: 30 s, then 1 min, then 5 min; persisted across restarts (D8).
- Recovery code: 24 characters, 6 groups of 4, not case-sensitive, shown once (D6, design L4/L5).
- Privacy screen wording: "Lock private notes with a PIN"; keep "It does not encrypt the notes file." (D10).
- All SQL in `crates/desknotes-core`; schema changes only by appending migration v4.
- PIN, hashes, recovery code: never logged, never returned to the webview (the recovery code is returned once, at issue time, to the Settings window only).
- Platform code (D-Bus, polkit, process checks) only in `src-tauri/src/platform`.
- Screens follow `DeskNotes Lock Settings Reminders.dc.html` frames L2, L3, L4, L5, S1, S2; anything without a frame reuses existing components and `src/styles/tokens.css` only.
- Commits: Conventional Commits with `Refs: DES-<n>` (create the Jira task for the privacy lock under DES-4 first and use its key).

## Review Focus

1. **Lock while a private note has unsaved text** → the text is saved first; if it cannot be saved, that note stays open with "Not saved" (others lock) and locks once its save succeeds. Test in Task 5.
2. **DeskNotes restarted during a wrong-PIN wait** → the wait still applies with the remaining time. Test in Task 3.
3. **Search for a word that appears only inside a locked private note** → no result, no snippet; searching its label finds it. Test in Task 4.
4. **System clock moved backwards during a wait** → the wait never exceeds the current step (no hours-long lockout). Test in Task 2.
5. **"Make private" with no PIN set up** → the PIN setup opens first; the note is not marked private until a PIN exists. Test in Task 8.

---

### Task 1: Private flag and label in the core

**Files:**
- Modify: `crates/desknotes-core/src/db/migrations.rs` (append v4)
- Modify: `crates/desknotes-core/src/model.rs`, `crates/desknotes-core/src/validation.rs`, `crates/desknotes-core/src/db/notes.rs`
- Test: same files' `#[cfg(test)]` modules

**Interfaces:**
- Produces:
  - Migration v4: `ALTER TABLE notes ADD COLUMN private INTEGER NOT NULL DEFAULT 0;` and `ALTER TABLE notes ADD COLUMN private_label TEXT NOT NULL DEFAULT '';`
  - `model.rs`: `pub const PRIVATE_LABEL_MAX_CHARS: usize = 40;`, `pub const PRIVATE_FALLBACK_LABEL: &str = "Private note";`. `Note` and `NoteSummary` gain `pub private: bool`, `pub private_label: String`, `pub locked: bool` (serde camelCase: `private`, `privateLabel`, `locked`; `locked` is set by Task 4, false here).
  - `validation.rs`: `pub fn validate_private_label(label: &str) -> CoreResult<String>` — trims; ≤ 40 chars; no control characters.
  - `db/notes.rs`: `pub fn set_private(&self, id: &str, private: bool, label: &str) -> CoreResult<()>` (label stored validated; clearing `private` keeps the label).

- [ ] **Step 1: Write failing tests**: `migration_v4_adds_private_columns_and_keeps_notes` (v3 db with a note → upgrade → note intact, `private == false`, label `""`); `set_private_round_trips_with_label`; `private_label_is_trimmed_and_limited` (41 chars → `validation`, `"a\u{7}"` → `validation`, `"  Bank "` → `"Bank"`).
- [ ] **Step 2: Run** `cargo test -p desknotes-core private` → FAIL (no column / no fn).
- [ ] **Step 3: Implement** the migration, fields (all `SELECT`s that build `Note`/`NoteSummary` read the two columns), validator and `set_private`.
- [ ] **Step 4: Run** `cargo test -p desknotes-core` → all pass (existing backup/upgrade tests included).
- [ ] **Step 5: Commit** `feat(core): private flag and label for notes`.

### Task 2: PIN rules, hashing, recovery codes and throttle (pure)

**Files:**
- Create: `crates/desknotes-core/src/privacy.rs` (+ `pub mod privacy;` in `lib.rs`)
- Modify: `crates/desknotes-core/Cargo.toml` (`argon2 = "0.6"` with its `std`/password-hash features; random salt from `OsRng`), `docs/design.md` dependency table if the exact version differs

**Interfaces:**
- Produces:
  - `pub const PIN_DIGITS: usize = 6;`
  - `pub fn validate_new_pin(pin: &str) -> CoreResult<()>` — `Validation` unless exactly 6 ASCII digits, not all equal, not a run where each digit is the previous ±1 in one direction.
  - `pub fn hash_secret(secret: &str) -> CoreResult<String>` — Argon2id PHC string, random salt; parameters tuned so one hash takes 0.3–0.5 s in a release build on the owner's laptop (record the chosen m/t/p in a comment).
  - `pub fn verify_secret(phc: &str, secret: &str) -> bool` — false on malformed input.
  - `pub fn new_recovery_code() -> String` — 24 chars from `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`, formatted `XXXX-XXXX-XXXX-XXXX-XXXX-XXXX`.
  - `pub fn normalize_recovery_code(input: &str) -> Option<String>` — drops spaces and dashes, uppercases, `Some` only for 24 characters of that alphabet.
  - `#[derive(Default, Serialize, Deserialize)] pub struct Throttle { pub failures: u32, pub wait_until_ms: i64 }` with `pub fn record_failure(&mut self, now_ms: i64)`, `pub fn remaining_secs(&self, now_ms: i64) -> u64`, `pub fn reset(&mut self)`. Schedule (builder's call within D8): failures 1–4 no wait; 5th → 30 s; 6th → 60 s; 7th and later → 300 s.

- [ ] **Step 1: Write failing tests**: `accepts_six_digit_pins` (`"482915"` ok); `refuses_weak_or_malformed_pins` (`"12345"`, `"1234567"`, `"12a456"`, `"000000"`, `"123456"`, `"654321"`, `"345678"` → `validation`); `hash_then_verify` (right ok, wrong false, `"junk"` hash false; two hashes of the same PIN differ); `recovery_code_shape` (matches `^[A-HJ-NP-Z2-9]{4}(-[A-HJ-NP-Z2-9]{4}){5}$`, 100 codes all distinct); `recovery_code_normalizes` (`" k7qd m2xr-9fpa wt4h c8nb zl6e "` → `"K7QDM2XR9FPAWT4HC8NBZL6E"`, 23 chars → `None`, contains `O` → `None`); `throttle_schedule` (4 failures → 0 s; 5th → 30; 6th → 60; 7th → 300; 9th → 300); `throttle_clock_moved_back` (wait_until 300 s ahead, now 2 h earlier → `remaining_secs == 300`, never more than the current step).
- [ ] **Step 2: Run** `cargo test -p desknotes-core privacy` → FAIL.
- [ ] **Step 3: Implement** the module.
- [ ] **Step 4: Run** `cargo test -p desknotes-core` and `cargo clippy --workspace --all-targets -- -D warnings` → pass.
- [ ] **Step 5: Commit** `feat(core): PIN rules, Argon2id hashing, recovery codes and throttle`.

### Task 3: PIN storage in the database

**Files:**
- Create: `crates/desknotes-core/src/db/privacy.rs` (+ `mod privacy;` in `db/mod.rs`)

**Interfaces:**
- Consumes: Task 2 functions and `Throttle`.
- Produces (settings keys `pin_hash`, `pin_recovery_hash`, `pin_throttle`, `pin_reset_at`, `lock_after_minutes`):
  - `#[derive(Serialize)] #[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")] pub enum PinCheck { Ok, Wrong { wait_secs: u64 }, Waiting { wait_secs: u64 } }` → JSON `{"kind":"wrong","waitSecs":30}`
  - `pub fn pin_is_set(&self) -> CoreResult<bool>`
  - `pub fn set_new_pin(&self, pin: &str) -> CoreResult<()>` — validates, stores hash, resets throttle. Callers authorise first.
  - `pub fn check_pin(&self, pin: &str, now_ms: i64) -> CoreResult<PinCheck>` — `Waiting` without hashing while a wait runs; persists throttle on every failure; resets on success.
  - `pub fn issue_recovery_code(&self) -> CoreResult<String>` (stores only the hash of the normalized code), `pub fn has_recovery_code(&self) -> CoreResult<bool>`, `pub fn check_recovery_code(&self, code: &str, now_ms: i64) -> CoreResult<PinCheck>` (same throttle).
  - `pub fn clear_pin(&self) -> CoreResult<()>` — removes PIN, recovery hash and throttle; private flags and labels stay.
  - `pub fn record_pin_reset(&self, now_ms: i64)`, `pub fn pin_reset_at(&self) -> CoreResult<Option<i64>>`, `pub fn acknowledge_pin_reset(&self)` (all `CoreResult`).
  - `pub fn lock_after_minutes(&self) -> CoreResult<u32>` (default 5; damaged → 5), `pub fn set_lock_after_minutes(&self, minutes: u32) -> CoreResult<()>` (only 1, 5, 10, 15).

- [ ] **Step 1: Write failing tests**: `pin_set_check_and_wrong`; `wait_survives_reopening_the_database` (file-backed temp db: 5 wrong → close → reopen → `Waiting { wait_secs > 0 }` even with the right PIN); `recovery_code_checks_normalized_input_and_shares_the_throttle`; `clear_pin_keeps_private_notes` (private note stays private with label); `lock_after_accepts_only_offered_values` (7 → `validation`, damaged value → 5); `pin_reset_banner_round_trip`.
- [ ] **Step 2: Run** `cargo test -p desknotes-core db::privacy` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `cargo test -p desknotes-core` → pass.
- [ ] **Step 5: Commit** `feat(core): store the PIN, recovery code and wrong-PIN waits`.

### Task 4: Enforcement while locked (core)

**Files:**
- Modify: `crates/desknotes-core/src/db/mod.rs`, `db/notes.rs`, `db/backup.rs`
- Test: `crates/desknotes-core/tests/privacy_lock.rs` (integration test against `Database::open_in_memory()`)

**Interfaces:**
- Produces:
  - `pub fn set_privacy_locked(&self, locked: bool, keep_open: &[String])` — `keep_open` are note ids that stay readable/savable until `release_kept_open(id)` (Review Focus 1). Lock is *effective* only when `pin_is_set()`.
  - `pub fn privacy_locked(&self) -> bool`, `pub fn release_kept_open(&self, id: &str)`, `pub fn is_note_locked(&self, id: &str) -> CoreResult<bool>`.
  - Redaction of a locked private note: `content` = `validation::empty_doc()`, `title` = label or `PRIVATE_FALLBACK_LABEL`, `snippet = None`, `locked = true`. Applies to `get_note`, `notes_to_show`, `list_notes`.
  - `list_notes` with a query: locked private notes match on label only.
  - Refused with `CoreError::NotAllowed("private notes are locked")` for a locked private note: `save_content`, `duplicate_note`, `purge_note`, `set_private(id, false, _)`; `export_backup` and `restore_backup` when any private note exists (D12).

- [ ] **Step 1: Write failing tests** in `tests/privacy_lock.rs`: `locked_private_note_is_redacted_everywhere` (content == empty doc, title == "Bank", snippet None in list); `unlabelled_private_note_shows_fallback`; `search_does_not_see_locked_text` (body contains "passport" → query "passport" returns nothing; query "Bank" returns it); `locked_private_notes_cannot_be_saved_copied_or_destroyed` (each listed call → `not_allowed`); `export_and_restore_need_unlock_when_private_notes_exist`; `normal_notes_are_untouched_while_locked`; `kept_open_note_saves_until_released`; `no_pin_means_no_lock` (`set_privacy_locked(true, &[])` without a PIN → nothing redacted).
- [ ] **Step 2: Run** `cargo test -p desknotes-core --test privacy_lock` → FAIL.
- [ ] **Step 3: Implement** with interior mutability on `Database` (`Cell<bool>` + `RefCell<HashSet<String>>`; `Database` stays `Send`).
- [ ] **Step 4: Run** `cargo test -p desknotes-core` → pass.
- [ ] **Step 5: Commit** `feat(core): withhold locked private notes and refuse destructive actions`.

### Task 5: Privacy commands and the lock flow (shell)

**Files:**
- Create: `src-tauri/src/privacy.rs` (lock/unlock orchestration), `src-tauri/src/commands/privacy.rs`
- Modify: `src-tauri/src/windows/mod.rs` (`save_all_open_notes` returns `Vec<String>` of note ids not confirmed saved; update its callers to `.is_empty()`/`.len()`), `src-tauri/src/state.rs`, `src-tauri/src/lib.rs`, `src-tauri/src/commands/notes.rs` (`save_note_content`: on success call `release_kept_open` and re-lock that window via the event), `src-tauri/src/tray.rs` ("Lock now" item, shown when a PIN is set)

**Interfaces:**
- Consumes: Tasks 3–4.
- Produces:
  - Event `privacy-changed`, payload `{ locked: bool }`.
  - `privacy::lock(app: &AppHandle)` — no-op without a PIN; `save_all_open_notes` then `set_privacy_locked(true, &unsaved_private_ids)`; emit. Run off the main thread (it waits for windows).
  - `AppState`: `last_activity_ms: AtomicI64`, `new_pin_allowed: AtomicBool` (one-shot, set by Task 7 routes).
  - Commands (camelCase JSON): `privacy_status() -> PrivacyStatus { enabled, locked, lockAfterMinutes, recovery: "system" | "code" | "none", resetAt: Option<i64> }`; `unlock(pin) -> PinCheck`; `lock_now()`; `setup_pin(window, pin) -> SetupResult { recoveryCode: Option<String> }` (Settings window only; only when no PIN; issues a code when `recovery != "system"`); `change_pin(window, current, new) -> PinCheck`; `turn_off_lock(window, pin) -> PinCheck` (clears PIN); `new_recovery_code(window, pin) -> Option<String>`; `set_lock_after(window, minutes)`; `set_note_private(id, private, label)` (`not_allowed` without a PIN); `report_activity()`; `acknowledge_pin_reset()`. Settings-only commands reuse `only_from_settings` from `commands/settings.rs`. Startup: `set_privacy_locked(true, &[])` when a PIN is set.

- [ ] **Step 1: Write failing tests** (unit tests on the pure parts): `unsaved_private_ids_are_kept_open` (given labels+private ids → kept list); `status_reports_recovery_mode` (system available → "system"; else code present → "code"; else "none").
- [ ] **Step 2: Run** `cargo test -p desknotes` → FAIL.
- [ ] **Step 3: Implement**, register commands in `lib.rs`.
- [ ] **Step 4: Run** `cargo test --workspace`, `cargo clippy --workspace --all-targets -- -D warnings` → pass.
- [ ] **Step 5: Commit** `feat: lock and unlock private notes, privacy commands`.

### Task 6: Lock on sleep, screen lock and inactivity

**Files:**
- Create: `src-tauri/src/platform/lock_triggers.rs`
- Modify: `src-tauri/Cargo.toml` (`zbus = "5"` resolving to the 5.13.2 already in `Cargo.lock`, blocking API), `src-tauri/src/lib.rs` (start watchers and the inactivity check in `setup`), `docs/design.md` dependency table (zbus)

**Interfaces:**
- Consumes: `privacy::lock`, `AppState.last_activity_ms`, `db.lock_after_minutes()`.
- Produces: `pub fn watch(on_lock: impl Fn() + Send + Sync + Clone + 'static)` — threads on: system bus `org.freedesktop.login1.Manager.PrepareForSleep(true)`; session bus `org.gnome.ScreenSaver.ActiveChanged(true)`; fallback `org.freedesktop.login1.Session.Lock` for this session. Errors are logged once and never stop the app.
  - Inactivity: a thread checks every 30 s; locks when enabled, unlocked and `now - last_activity_ms >= minutes * 60_000`. `unlock` and `report_activity` refresh `last_activity_ms`.
  - Pure helper `pub fn inactive_long_enough(now_ms: i64, last_ms: i64, minutes: u32) -> bool`.

- [ ] **Step 1: Write failing test** `inactive_long_enough` (4:59 of 5 min → false, 5:00 → true; clock moved back (now < last) → false).
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** `cargo test --workspace`, clippy → pass.
- [ ] **Step 5: Commit** `feat: lock private notes on sleep, screen lock and inactivity`.

### Task 7: Forgotten PIN — Ubuntu password, recovery code, `--reset-pin`

**Files:**
- Create: `src-tauri/src/platform/system_auth.rs`, `src-tauri/polkit/io.github.krusselalex.desknotes.policy`
- Modify: `src-tauri/tauri.conf.json` (`bundle.linux.deb.files`: install the policy to `/usr/share/polkit-1/actions/io.github.krusselalex.desknotes.policy`), `src-tauri/src/lib.rs` (`--reset-pin` before the builder), `src-tauri/src/commands/privacy.rs`

**Interfaces:**
- Produces:
  - Policy action `io.github.krusselalex.desknotes.reset-pin`; `allow_active` = `auth_self`, `allow_inactive` = `no`, `allow_any` = `no`; message "Authenticate to choose a new DeskNotes PIN".
  - `pub fn system_auth_available() -> bool` — policy file present and `pkcheck` on PATH and not running from an AppImage (`APPDIR` set).
  - `pub fn ask_system_password() -> bool` — `pkcheck --action-id io.github.krusselalex.desknotes.reset-pin --process <own pid> --allow-user-interaction`; true only on exit 0.
  - Commands: `forgot_pin_system() -> bool` (on true: unlock and set `new_pin_allowed`); `recover_with_code(code) -> PinCheck` (on Ok: same); `choose_new_pin(pin) -> SetupResult` (consumes `new_pin_allowed`, else `not_allowed`; issues a new recovery code when recovery mode is "code").
  - CLI `desknotes --reset-pin` (D11): refuses while another DeskNotes runs (check the single-instance plugin's D-Bus name, see `tauri-plugin-single-instance`'s Linux implementation for the exact name); if `system_auth_available()` requires `ask_system_password()`; then `clear_pin()` + `record_pin_reset(now)`; prints the outcome; exits 0/1.

- [ ] **Step 1: Write failing tests**: `choose_new_pin_needs_a_proof` (without flag → `not_allowed`); policy file test reading the XML: action id, `auth_self` for `allow_active`, `no` elsewhere.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** tests + clippy → pass; build the `.deb` and check `dpkg-deb -c` lists the policy file.
- [ ] **Step 5: Commit** `feat: forgotten PIN with the Ubuntu password, recovery code or --reset-pin`.

### Task 8: Note window — locked view and "Make private"

**Files:**
- Create: `src/features/privacy/PinPad.tsx` (design L2/L3: 6 dots, digit keys, typing, countdown with keys disabled, "Forgot your PIN?"), `src/features/privacy/PrivateLabelDialog.tsx` (S3 modal style, optional label ≤ 40 chars)
- Modify: `src/types/note.ts` (`private`, `privateLabel`, `locked` on `Note`/`NoteSummary`; `PrivacyStatus`, `PinCheck`, `SetupResult`), `src/ipc/commands.ts`, `src/ipc/events.ts` (`onPrivacyChanged`), `src/features/notes/NoteWindow.tsx`, `src/dev/preview.tsx` (mocks + `?locked=private`)
- Test: `src/features/privacy/PinPad.test.tsx`, `src/features/notes/NoteWindow.test.tsx`

**Interfaces:**
- Consumes: commands from Tasks 5 and 7.
- Produces: `PinPad({ onUnlocked, onForgot }: { onUnlocked: () => void; onForgot: () => void })` (reused by Task 10).

- [ ] **Step 1: Write failing tests**: `locked_note_never_mounts_the_editor` (note `locked: true` → no `textbox "Note text"`, label shown); `six_digits_unlock_and_reload_the_note`; `wrong_pin_shows_countdown_and_disables_keys` (`{kind:"wrong", waitSecs: 30}` → "Try again in 30 s", keys disabled); `lock_event_unmounts_editor_after_saving` (privacy-changed locked → editor gone, `saveNoteContent` called before); `make_private_without_pin_opens_setup_first` (Review Focus 5: `privacyStatus.enabled=false` → `openSettings` called, `setNotePrivate` not called); `make_private_with_label`.
- [ ] **Step 2: Run** `npx vitest run src/features/privacy src/features/notes` → FAIL.
- [ ] **Step 3: Implement.** The locked view replaces the body; header keeps colour, label and the window controls.
- [ ] **Step 4: Run** `npm test && npm run lint && npm run typecheck` → pass. Check the preview against L2/L3 in light and dark.
- [ ] **Step 5: Commit** `feat: locked private notes and Make private in the note window`.

### Task 9: Settings → Privacy

**Files:**
- Create: `src/features/settings/PrivacyPane.tsx` (S2), `src/features/settings/PinSetup.tsx` (S1 choose/confirm with mismatch state; L5 recovery code step with Copy, Print, "I've written it down" when a code is issued), `src/features/settings/ChangePin.tsx` ("Change PIN · 1 of 3")
- Modify: `src/features/settings/SettingsWindow.tsx` (add the Privacy section with the `lock` icon between General and Backup, as in S2)
- Test: `src/features/settings/PrivacyPane.test.tsx`

**Interfaces:**
- Consumes: `privacy_status`, `setup_pin`, `change_pin`, `turn_off_lock`, `new_recovery_code`, `set_lock_after`, `lock_now`.

- [ ] **Step 1: Write failing tests**: `turning_on_runs_choose_confirm_and_shows_code_when_issued`; `mismatch_keeps_step_two_with_message` ("The PINs don't match. Enter it again."); `weak_pin_is_explained` (core `validation` message shown); `no_code_step_when_system_password_is_the_backup`; `lock_after_options_are_1_5_10_15`; `wording_says_private_notes_and_does_not_encrypt` (D10 text).
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** `npm test && npm run lint && npm run typecheck`; preview vs S1/S2/L5 light and dark.
- [ ] **Step 5: Commit** `feat: Privacy settings, PIN setup and change`.

### Task 10: Forgotten PIN screens, manager and tray

**Files:**
- Create: `src/features/privacy/ForgotPin.tsx` (system route: calls `forgotPinSystem()`, then new PIN via `PinSetup` in "choose new" mode; code route: L4 entry, then new PIN)
- Modify: `src/features/manager/ManagerWindow.tsx` (private rows: `lock` icon + label; click on a locked row → `showNote`; ⋯ "Lock now" when enabled and unlocked; reset banner from `resetAt` with an "OK" that calls `acknowledgePinReset`), `src/features/settings/BackupPane.tsx` (export/restore answered `not_allowed` while private notes are locked → `PinPad` in an S3-style modal, then retry once unlocked)
- Test: `src/features/privacy/ForgotPin.test.tsx`, `src/features/manager/ManagerWindow.test.tsx`

- [ ] **Step 1: Write failing tests**: `system_route_then_new_pin`; `cancelled_system_prompt_changes_nothing`; `recovery_code_route_accepts_any_spacing`; `locked_rows_show_label_not_title`; `lock_now_in_menu_only_when_enabled`; `reset_banner_needs_acknowledging`; `export_while_locked_asks_pin_then_exports`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** all frontend checks; preview vs L4.
- [ ] **Step 5: Commit** `feat: forgotten PIN screens, private rows and Lock now in the manager`.

### Task 11: Real-app verification and release notes

**Files:**
- Create: `docs/testing/m3-verification.md`
- Modify: `CHANGELOG.md` (Unreleased), `docs/design.md` §7 (mark the forgotten-PIN proposal as decided: D5, D6, D11)

- [ ] **Step 1:** Run the `desknotes-reviewer` agent on the branch; fix findings; re-run all checks.
- [ ] **Step 2:** Real app on Ubuntu 24.04 (release build, isolated data; `desknotes-verify-ubuntu` skill), recording each in `docs/testing/m3-verification.md`: set up PIN; make a note private with a label; Lock now → note shows label + L2, manager row shows label; `get_note`-level check that no text reached the webview (DevTools-free: read the IPC response via a debug log of byte counts only, or assert the editor DOM is absent); wrong PIN ×5 → 30 s wait, restart → wait persists; unlock; screen lock (`loginctl lock-session`) → locks; suspend trigger (owner check); inactivity at 1 min; type then Lock now within 500 ms → text saved; `--reset-pin` with DeskNotes running → refused, closed → asks the Ubuntu password; forgotten PIN via the Ubuntu password (owner check, real polkit prompt); backup export while locked → asks for PIN.
- [ ] **Step 3:** Update `CHANGELOG.md` and `docs/design.md` §7.
- [ ] **Step 4: Commit** `docs: privacy lock verification`.
