# Privacy lock for private notes — design (Milestone 3)

Status: proposed, 2026-11-02. Decisions marked **owner** were made by the owner in
conversation; decisions marked **builder's call** were made while writing this and can
be changed during planning.

## 1. Intent

DeskNotes runs on the owner's own laptop. Some notes should not be readable by someone
who uses or looks at that laptop while it is unlocked: a colleague at the desk, family,
a screen share. The lock hides those notes behind a short PIN that is quick to type every
day, and that someone else at the laptop cannot guess quickly or bypass.

It must stay **easy**: nothing long to remember, nothing awkward to store.

## 2. Goals, non-goals, anti-goals

Goals
- Notes the owner marks as **private** hide their text until a 6-digit PIN is entered.
- One PIN unlocks every private note at once, until the next lock.
- Locks by itself when the computer sleeps, when the screen locks, after a chosen period
  of inactivity, and on "Lock now".
- A forgotten PIN is replaced by proving you are the Ubuntu account owner (your Ubuntu
  password), with no recovery code to keep in the normal case.
- Locked text is withheld by the native layer: the webview never receives it.

Non-goals
- Encrypting the database. Someone who can read the file (stolen disk, root, malware
  running as the user) can read private notes. Ubuntu's full-disk encryption and the login
  password cover a stolen laptop. This limit is stated in Settings.
- Locking non-private notes or the whole app.
- Accounts, online recovery, e-mail/SMS, security questions (never, per `docs/design.md`).

Anti-goals (would be a failure even if it "works")
- Losing typed text because a lock happened (data safety comes first, CLAUDE.md).
- Any way for someone at the unlocked laptop to reset or skip the PIN without the Ubuntu
  password, from inside DeskNotes.
- Private text appearing anywhere while locked: note windows, manager snippets, search
  results, window titles, tray, notifications, exports, logs.

## 3. Decisions

| # | Decision | By |
|---|---|---|
| D1 | Only notes marked **private** are locked; other notes are unaffected. | owner |
| D2 | A locked private note shows its **colour and a label** the owner may type when making it private (e.g. "Bank"); an empty label shows "Private note". Never the note's own title: titles are derived from the first line of the text (`derive_title`), so showing them would leak it. The PIN field sits inside the note window (design L2). Text, formatting, title and snippet are hidden. | owner (option B, after the review showed titles leak text) |
| D3 | Locks on: computer sleep, screen lock, inactivity (Settings: 1 / 5 / 10 / 15 min, design S2), "Lock now". | owner (sleep, screen lock); design (inactivity, Lock now) |
| D4 | PIN is exactly **6 digits**. | owner |
| D5 | Forgot PIN → **Ubuntu password** via the system's own prompt (polkit), then choose a new PIN. No recovery code, no terminal reset in that case. (Option C.) | owner |
| D6 | Where the Ubuntu-password route is unavailable (AppImage, which cannot install a polkit policy; non-GNOME desktops without a polkit agent), a **recovery code** is shown once at PIN setup, as in design L4/L5 (24 characters, 6 groups of 4, not case-sensitive), and is the way back. | builder's call |
| D7 | One PIN for all private notes; entering it unlocks all private notes until the next lock. | builder's call (proposed in conversation, not objected) |
| D8 | Wrong PIN: waits grow after repeated failures — 30 s, then 1 min, then 5 min (design L3); the counter and the wait survive restarting DeskNotes. | design; persistence: builder's call |
| D9 | Obvious PINs are refused when choosing one: all the same digit, straight runs (012345, 123456, 987654…). | builder's call |
| D10 | The Settings → Privacy wording follows D1: "Lock private notes with a PIN" instead of "Lock DeskNotes with a PIN"; the "does not encrypt the notes file" line stays. "New recovery code…" appears only where D6 applies. The whole-app lock screen in the export ("DeskNotes is locked", L1) is not used. | builder's call |
| D11 | Last resort when neither the Ubuntu password nor a recovery code works (e.g. the polkit file was removed, or the AppImage runs on data set up by the `.deb`): `desknotes --reset-pin`, with DeskNotes closed. Where polkit is available it asks for the Ubuntu password first, so it does not weaken D5; otherwise it resets, and the next start shows "The PIN was reset on <date>", which must be acknowledged (`docs/design.md` §7 option 2). | builder's call (owner had approved the terminal reset before choosing option C) |
| D12 | Locked private notes cannot be destroyed or copied either: Duplicate, Delete permanently, Empty trash (when it holds private notes), Restore from backup (when private notes exist) and turning the lock off ask for the PIN first. Moving, resizing, colour, hide and show stay allowed. | builder's call |
| D13 | Unlocking from the manager: clicking a locked private note opens its window at the PIN field (L2). No separate manager lock screen. "Lock now" is also in the manager ⋯ menu and the tray. | builder's call |

## 4. How it behaves

### 4.1 Setting up
- Settings → Privacy → turn on "Lock private notes with a PIN": choose PIN, confirm PIN
  (design S1 "Set up lock", mismatch state). Where D6 applies, step 3 shows the recovery
  code (design L5) and requires "I've written it down".
- Marking a note private with no PIN yet starts the same setup first.
- Turning the lock off requires the PIN (or the Ubuntu password); private flags are kept
  but have no effect while the lock is off. *Builder's call.*

### 4.2 Marking notes private
- Note window ⋯ menu: "Make private" / "Make not private" (no design exists; follow the
  existing menu item style and the edit-lock pattern). "Make private" asks for the optional
  label (D2) in a small dialog built like the shortcut dialog (S3 modal, tokens only); the
  label can be changed later from the same menu while unlocked. Stored in a new column
  (appended migration), validated in Rust (plain text, short, e.g. ≤ 40 characters). Manager: a small private indicator
  on the row, using an existing icon (`lock`) from `src/components/icons.ts`.
- "Make not private" requires the note to be unlocked.

### 4.3 Locking
- Triggers (D3). Sleep: logind `PrepareForSleep` on the system bus. Screen lock: GNOME
  ScreenSaver `ActiveChanged` (session bus); fallback to logind session `Lock` signal.
  Inactivity: no input in any DeskNotes window for the chosen time (DeskNotes cannot see
  input to other apps without extra permissions). *Builder's call for exact APIs.*
- On lock, **save first**: run the existing save-all handshake. Every private note that
  saved is switched to its locked view and its content is dropped from the webview (the
  editor is unmounted, not hidden). A private note that **cannot** save stays open with
  its "Not saved" message rather than losing text; it locks as soon as its save succeeds.
  *Builder's call, from the data-safety rule.*
- Lock state lives in the native app state (memory). DeskNotes starts locked whenever a
  PIN is set.

### 4.4 While locked (native enforcement)
- The core/shell never returns a locked private note's content or snippet to any window:
  `get_note`, list/search, collapse previews, backup export.
- Saves to a locked private note are refused (like the edit lock).
- Search ignores locked private notes entirely except their label (D2).
- Backup export while private notes are locked asks for the PIN first. *Builder's call.*
- Window titles stay "DeskNotes"; tray and future reminder notifications show the label
  (or "Private note") for private notes, never their title.
- Destructive or copying actions follow D12.

### 4.5 Unlocking
- PIN field inside any locked private note (design L2), or in the manager. Correct PIN
  unlocks all private notes (D7). Wrong PIN: message and countdown, keypad and typing
  disabled during the wait (design L3).
- PIN checked in Rust against an Argon2id hash (crate `argon2` 0.6, already listed in
  `docs/design.md`); salt per hash; parameters chosen so one check takes roughly
  0.3–0.5 s on the owner's laptop. Constant-time comparison is provided by the crate.

### 4.6 Forgotten PIN (D5, D6)
- "Forgot your PIN?" → system password prompt via polkit, using a policy installed by the
  `.deb` (`/usr/share/polkit-1/actions/…desknotes…policy`, `auth_self`, every time, no
  caching). Success → choose and confirm a new PIN. Failure/cancel → nothing changes.
- Where the policy or a polkit agent is missing: the recovery code entry (design L4),
  then choose a new PIN and receive a new recovery code.
- If neither works: `desknotes --reset-pin` (D11).
- Changing the PIN (Settings, design "Change PIN · 1 of 3"): current PIN, new, confirm.

## 5. Constraints
- All SQL in `crates/desknotes-core`; new columns by an appended migration (v4), never
  editing shipped ones; the pre-migration backup already exists.
- PIN, PIN hash, recovery code and lock state never logged, never sent to the webview
  except the PIN digits typed in the field (sent once to the unlock command).
- Platform code (D-Bus, polkit) in `src-tauri/src/platform`.
- No network. New crates only if MIT/Apache-compatible and listed in `docs/design.md`.
- Screens follow the owner's design export (`DeskNotes Lock Settings Reminders.dc.html`:
  L2–L5, S1, S2); new pieces (Make private menu item, manager indicator, D10 wording)
  reuse existing components and tokens.
- Real-app verification on Ubuntu 24.04, recorded in `docs/testing/`.

## 6. Left to the builder
- Exact Argon2id parameters, storage layout of the PIN hash, throttle state and recovery
  code hash (settings table vs. a new table), and the migration details.
- D-Bus library choice and how signals reach the app thread.
- How the webview drops content on lock (unmount strategy) and how a locked note window
  renders (within design L2).
- polkit integration mechanics (`pkcheck` vs. the D-Bus API) and policy file packaging.
- Test strategy, including security tests: no content in IPC responses while locked,
  throttle survives restart, refused saves.
