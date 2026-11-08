# Milestone 3 — privacy lock: verification on Ubuntu

Date: 2026-11-03 · Branch: `feat/m3-privacy-lock` · Jira: DES-28
Design: `docs/superpowers/specs/2026-11-02-privacy-lock-design.md` (D1–D14)

## Machine and conditions

| Item | Value |
|---|---|
| OS | Ubuntu 24.04.5 LTS, GNOME 46 on Wayland; DeskNotes through XWayland (ADR-0002) |
| Build | release binary (`npm run tauri build -- --no-bundle`), not the `.deb` |
| Data | isolated test folder (`XDG_DATA_HOME`), not the owner's notes |
| polkit policy | **not installed** (it comes with the `.deb`), so the recovery route is the recovery code |
| Method | tray driven over D-Bus (`scripts/verify/tray.py`), clicks/keys with libxdo (`scripts/verify/x.py`), database read-only, screenshots of the real windows |

## Checked in the real app (release build, scratch data)

| Check | Result |
|---|---|
| Settings → Privacy, lock off | "Lock private notes with a PIN — Hides the text of private notes in every window until unlocked." and the "does not encrypt the notes file" notice (D10) |
| Set up: choose PIN, confirm | 1 of 3, 2 of 3 as in the design; then step 3 shows the 24-character recovery code once with Copy / Print; "Turn on lock" stays disabled until "I've written it down" is ticked |
| Stored after set-up | `pin_hash` and `pin_recovery_hash` are Argon2id hashes; `recovery_method = code` (computer password not offered: no polkit policy) |
| Privacy pane, lock on | Lock after 1 / 5 / 10 / 15 min (5 selected), "If I forget my PIN: Use a recovery code", Lock now, Change PIN…, New recovery code… |
| Make private (⋯ menu) | Label dialog (optional label); note stored `private = 1`; tray gains "Lock now" |
| Lock now (tray) | Note shows only "Private note", its colour, the keypad and "Forgot your PIN?"; no text |
| Manager while locked | Row shows the lock icon and "Private note"; no title, no snippet |
| Search while locked | Searching a word that is only inside the private note ("0042") finds nothing |
| Wrong PIN ×5 (keypad) | 5th failure: "Wrong PIN. Try again in 28 s", keys disabled (L3) |
| Restart during the wait | Note reopens **locked**; the correct PIN is refused with "Try again in 4 s" (remaining time); failures stay at 5 |
| Correct PIN after the wait | Unlocks; text back; wrong-PIN counter cleared |
| Export backup while locked | "Unlock private notes — Enter your PIN so the backup includes them." appears; no file dialog opened first (R11) |
| `desknotes --reset-pin` while DeskNotes runs | Refused ("DeskNotes is running. Quit it first … Nothing was changed."), exit 1, PIN kept |
| `desknotes --reset-pin` with DeskNotes closed | "The PIN was removed …", exit 0; `pin_reset_at` recorded; private flags kept |
| Next start with a note on screen | Manager opens by itself with "The PIN was reset on Nov 3, 2026, 12:18 AM. Private notes are not locked until you choose a new PIN …" and OK (final-review fix) |
| Type, then Lock now 184 ms later (inside the 500 ms autosave delay) | Database holds the last words; the note then locks (no text lost) |
| Inactivity, lock after 1 min | Unlocked note locked by itself within 2 minutes without input (check runs every 30 s) |

Test-tool notes: simulated typing uses a QWERTY map on the owner's AZERTY layout, so letters
come out swapped ("Bank" → "Bqnk"); digits arrive correctly. Keyboard focus only follows a
newly opened window or a click on text inside the editor.

## Needs the owner (real session, installed `.deb`)

These touch the owner's own session or need a real person at the password prompt:

| Check | Result |
|---|---|
| Install `.deb`: `pkaction --verbose --action-id io.github.krusselalex.desknotes.reset-pin` shows `auth_self` | Passed 2026-11-03: `.deb` reinstalled (binary and policy dated 3 Nov 00:29); `implicit active: auth_self`, `implicit any/inactive: no` |
| Set up with "Use my computer password"; "Forgot your PIN?" opens Ubuntu's password dialog (accept → choose a new PIN in Settings; cancel → nothing changes; asked again each time) | Passed 2026-11-03 (owner): polkit journal shows two cancelled attempts (07:14:35, 07:14:39, "FAILED to authenticate") then "ONE-SHOT authorization" at 07:14:57 for `/usr/bin/desknotes`; a new Argon2id PIN stored with `recovery_method = system` |
| Super+L (screen lock) locks private notes; only one lock | Passed 2026-11-03 (owner): a D-Bus watcher saw two screen locks (07:33:51, 07:34:18: `ScreenSaver.ActiveChanged(true)` and logind `LockedHint` true) and the unlocks; the owner saw the private note locked each time |
| Suspend and resume locks private notes | **Not run** with this build: no suspend in the system log since the `.deb` was installed (last one 2026-11-02 22:28, older build); the watcher saw no `PrepareForSleep`. The lock path is the same as for the screen lock (`lock_automatically`) |
| `desknotes --reset-pin` with polkit installed asks for the Ubuntu password | Passed 2026-11-03 on the owner's data (installed `.deb`, database upgraded to version 4 with a backup first): refused three times while DeskNotes ran (started by the show/hide shortcut; the open window was not the app); after tray → Quit DeskNotes it printed "Enter your Ubuntu password in the window that opens.", the owner authenticated, then "The PIN was removed …". Read-only check: `pin_hash` and recovery hash gone, `pin_reset_at` recorded, the private note keeps `private = 1`. Next start (by the show/hide shortcut, a note on screen): the manager opened by itself with the "PIN was reset" notice (owner confirmed) |
| A locked private note collapses to its header and expands again, still locked (DES-46) | Passed 2026-11-08 (owner) on the `.deb` of main 56d437e: the running DeskNotes was started at 10:25 from that binary. Read-only check: a PIN is set, lock after 1 min, 4 private notes; the one on screen is stored collapsed |
| Copy and Print of a recovery code (clipboard, print dialog) | **Not confirmed**: no recovery code is stored (`recovery_method = system`). The code screen and its Copy / Print buttons were seen in the scratch-data run above, not pressed |

## Privacy hardening (DES-30, 2026-11-08)

`desknotes --reset-pin` from a debug build of `fix/des-30-privacy-security`, on scratch
data (`XDG_DATA_HOME` in a scratch folder, made with a PIN, a recovery code and one
private note), each run on its own private D-Bus (`dbus-run-session`). `APPDIR` was set so
no Ubuntu password prompt opened. The database was read with Python `sqlite3`, read-only.

| Check | Result |
|---|---|
| Another process owns `io.github.krusselalex.desknotes.SingleInstance` (as a running DeskNotes does) | "DeskNotes is running. Quit it first …", exit 1; PIN, recovery code and private flag unchanged, no reset notice |
| Name free | "The PIN was removed …", exit 0; PIN and recovery code gone, reset notice recorded, the note still private |
| Run again | "No PIN is set. Nothing was changed.", exit 0 |
| The claim test on a private bus (`a_claim_keeps_others_out_until_dropped`, ignored by default) | Passes |

**Not checked in the real app:** the Ubuntu password prompt with the new
`pid,start-time,uid` subject (it opens on the owner's screen: an owner check on the
next `.deb`), and a DeskNotes started while that prompt is open (the name is let go during
the prompt; the reset is then refused). The other DES-30 changes are covered by unit tests:
the proof of a forgotten PIN ends on a PIN change, removal, setup or lock; a lock whose PIN
went during the save round locks nothing; labels lose hidden characters, also when saved
before the rule.

## Automated tests at the end of the branch

`cargo test --workspace` (core 82 unit + 1 + 16 lock tests; desktop 46, 2 ignored), 217
frontend tests, `cargo clippy -D warnings`, `npm run lint`, `npm run typecheck`: all pass.
Every task was reviewed separately, then the whole branch by a final reviewer; findings fixed.
