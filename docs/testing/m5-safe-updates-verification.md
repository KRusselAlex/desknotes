# Milestone 5 — safe updates: verification on Ubuntu

Date: 2026-11-05 · Branch: `feat/safe-updates` (3f57969) · Jira: DES-22
Design: `docs/superpowers/specs/2026-11-05-safe-updates-design.md`

## Machine and conditions

| Item | Value |
|---|---|
| OS | Ubuntu 24.04.5 LTS, GNOME 46 on Wayland |
| Previous release | The real **v0.2.0** package from the GitHub release (`DeskNotes_0.2.0_amd64.deb`, checked against its `SHA256SUMS`). It was unpacked with `dpkg-deb -x` and not installed. |
| Today's build | The release binary of this branch (`npm run tauri build -- --no-bundle`) |
| Data | A scratch `HOME`, so `~/.local/share/io.github.krusselalex.desknotes/` was a throwaway folder. It started from the committed fixture `crates/desknotes-core/tests/fixtures/release-0.2.0.db`, made by v0.2.0's own code. |
| Isolation | Each run had its own D-Bus session (`dbus-run-session`) and a hidden X display (`Xvfb`). The owner's DeskNotes kept running untouched, and no window appeared on their screen. |
| Method | Windows counted with `xwininfo`; the database read with Python `sqlite3` in read-only mode; a digest of every note's id, title, content and colour. The app was stopped with SIGTERM, which leaves `-wal`/`-shm` files behind, a harder case than a normal quit. |

Under a private D-Bus session, GTK waits about 25 seconds for desktop services before the windows appear, so each run waited 40 seconds. That only happens in this test set-up.

## Upgrade and rollback, step by step

The rollback commands were copied out of `docs/upgrading.md` by script and run exactly as written. Only `~` pointed at the scratch folder. The `apt install` step was replaced by running the unpacked v0.2.0 binary.

| Run | What | Result |
|---|---|---|
| A | v0.2.0 opens the fixture | 3 windows (two notes and one collapsed to its 32 px header) at their saved places; schema 3; 5 notes (3 active, 1 archived, 1 in trash) |
| B | Today's build opens the same file (the upgrade) | Schema 7, same 5 notes, same digest, same 3 windows at the same places; `backups/pre-migration-v3-….db` written |
| — | A change after the upgrade | One title edited directly in the scratch database ("… (edited after upgrade)") |
| C | v0.2.0 started on the upgraded file, without rolling back | Refused with "The notes database could not be opened: database schema version 7 is newer than this DeskNotes supports (3); it was left untouched". `desknotes.db` byte-identical before and after. |
| D | `upgrading.md` steps 2–3, then v0.2.0 | The newest `v3` copy was picked and the current file moved to `rolled-back-…/`. v0.2.0 opens it: same 3 windows, schema 3, digest equal to run A. The post-upgrade edit is not in the copy, as the document says. |
| E | "Getting the newer notes back" block, then today's build | The edited title is back, schema 7, 3 windows |
| F | Steps 2–3 again, now with `desknotes.db-wal` and `-shm` present | All three files moved together into a new `rolled-back-…/`. v0.2.0 opens the copy, and the digest again equals run A. |

The `-wal` file in run F was empty (SQLite had already written its contents back). A non-empty `-wal` is covered by the same `mv desknotes.db*` line but was not produced here.

## Checked by tests (not the real app)

| Check | Where |
|---|---|
| A real v0.2.0 database upgrades with every note, window and setting kept, plus the defaults of the columns added since | `crates/desknotes-core/tests/release_upgrade.rs` |
| A database from a newer version keeps its exact bytes, gets no backup, and leaves no `-wal`/`-shm`/`-journal` (rollback-journal and WAL files) | `db::tests::newer_database_message_and_untouched`, `newer_wal_database_is_refused_and_untouched` |
| The plain message at start-up and in Forgot PIN | `state::tests::newer_database_message`, `reset_pin` tests |
| Release tag, version, beta, on-main and CHANGELOG rules | `bash scripts/release/test.sh` (35 cases) |

## Found while testing

- Before this branch, opening a database from a newer version switched it to WAL **before** refusing it, which rewrote its header. It is fixed: the version is now checked first.
- Tauri writes a beta version into the .deb unchanged (`0.3.0-beta.1`, checked with `dpkg-deb -f`). dpkg sorts that **after** `0.3.0`, so apt calls installing the final release over a beta a "downgrade". `docs/upgrading.md` and `docs/releasing.md` explain it.
- The v0.2.0 release on GitHub is still a **draft**, so nobody can download it yet. Publishing it is the owner's decision.

## Not checked

| Item | Why |
|---|---|
| `sudo apt install` of the old .deb, and apt's "DOWNGRADED" notice | It would replace the owner's installed DeskNotes. The notice is standard apt behaviour for a lower version. |
| The release workflow on a real tag | No tag was pushed; tagging is the owner's decision. The scripts are tested locally; the workflow's wiring was checked by reading and by running its step bodies under `bash -eo pipefail`. |
| The provenance attestation (`gh attestation verify`) | Only exists after a tagged run |
