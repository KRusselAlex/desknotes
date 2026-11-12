# 0.3.0-beta.1 — the real beta packages: upgrade and rollback on Ubuntu

Date: 2026-11-12 · Release: draft pre-release `v0.3.0-beta.1` (tag on `2decd99`, release run 43014454196) · Jira: DES-22
Method as in [m5-safe-updates-verification.md](m5-safe-updates-verification.md).

## Machine and conditions

| Item | Value |
|---|---|
| OS | Ubuntu 24.04.5 LTS, GNOME 46 on Wayland |
| Packages | `DeskNotes_0.3.0-beta.1_amd64.deb` and `.AppImage` from the draft pre-release, and `DeskNotes_0.2.0_amd64.deb` from the v0.2.0 draft. Each was checked against its release's `SHA256SUMS`. The `.deb` files were unpacked with `dpkg-deb -x` and the AppImage with `--appimage-extract`; nothing was installed. |
| Provenance | `gh attestation verify` is not in the `gh` from Ubuntu's packages (2.45; the command needs 2.49). Instead, `gh api repos/KRusselAlex/desknotes/attestations/sha256:<digest>` returned one SLSA provenance attestation whose subjects are the `.deb`, the AppImage and `SHA256SUMS`, with the same digests as `SHA256SUMS`, built by `.github/workflows/release.yml` at `refs/tags/v0.3.0-beta.1`. |
| Data | A scratch `HOME`, starting from the committed fixture `crates/desknotes-core/tests/fixtures/release-0.2.0.db` (written by v0.2.0's own code: 5 notes, of which 3 active, 1 archived, 1 in trash; one pinned, one read-only, one collapsed). |
| Isolation | A hidden X display (`Xvfb :78`) and a private D-Bus session per run. The owner's installed DeskNotes 0.2.0 kept running untouched (same process before and after). |
| Method | Real typing and clicks with `scripts/verify/x.py`; screenshots of the windows; the database read in read-only mode. A digest of every note's id, title, content, colour, dates and read-only flag, and one of the window rows. The apps were stopped with SIGTERM, which leaves `-wal`/`-shm` files behind. |

## Runs

| Run | What | Result |
|---|---|---|
| A | 0.2.0 opens the fixture; a list item "Tea typed in 0.2.0" is typed into the pinned note | 3 windows at their saved places; the note shows "Saved"; schema 3, 5 notes. The `-wal` file (8 KB) was left non-empty for the upgrade. |
| B | The beta `.deb` opens the same folder (the upgrade) | Schema 8; same 5 notes and the same digest as after A (the typed item included); the same 3 windows at the same places, pinned, read-only and collapsed as before. `backups/pre-migration-v3-….db` written, and its digest equals A. No welcome note was added to an existing set of notes. The format bar has the new image and text-style buttons. |
| — | A change in the beta | "Jam typed in the beta" typed and saved |
| C | 0.2.0 started on the upgraded folder, without rolling back | Refused, with an empty manager. The notes are unchanged: same digest as after the beta's change, and `integrity_check` is `ok`. The file is **not** byte-identical: 0.2.0's refusal folded the beta's `-wal` file into `desknotes.db`. That 0.2.0 bug is fixed in 0.3.0 (see `CHANGELOG.md`). The manager showed only "the notes database is not open"; the full reason went to the terminal. |
| D | `upgrading.md` steps 2–3, copied out of the document by script, then 0.2.0 | Run as written, the step 3 block refused at once, because the owner's own DeskNotes was running. That is its guard working. With `pgrep` limited to the test binaries, the block picked the only `v3` copy, moved `desknotes.db`, `-wal` and `-shm` into `rolled-back-…/`, and copied the backup in. 0.2.0 then opened it: digest equal to A, 3 windows, the 0.2.0 item present and the beta item absent, as the document says. |
| E | "Getting the newer notes back", with the folder name filled in as the document says, then the beta | The beta's data is back (digest equal to after the beta's change, "Jam" present), schema 8, 3 windows. No new pre-migration copy, since nothing needed upgrading. |
| G | The beta on a copy marked layout 9 (as from a newer DeskNotes) | Refused, and the file stayed byte-identical. **Found:** the manager showed "the notes database is not open", not the plain "Your notes were saved by a newer version…" message (only printed to the terminal). Fixed on this branch; see below. |
| H | This branch's debug build on the same layout-9 copy (repeated after the review's changes, same result) | The manager shows "Your notes were saved by a newer version of DeskNotes. Install that version (or newer) to open them; nothing was changed." It still shows it after clicking Retry and New note. The file stayed byte-identical. |
| I | This branch's debug build on the normal upgraded folder | 3 windows, no error, same digest |
| J | The beta AppImage (extracted) on the same folder | 3 windows, same digest |

## Found while testing

- **The plain message for notes from a newer DeskNotes never reached the screen.** `ManagerWindow` showed `error ?? startupErrors[0]`. With no database, every list read fails with `database_unavailable` ("the notes database is not open"), and that error always won. The manager has worked this way since Milestone 1, so 0.2.0 does it too. Fix: each error in the banner records whether it only says "not open" (code `database_unavailable`). Only such an error gives way to the startup reason, so any other message, such as "DeskNotes did not quit…", still shows. Retry dismisses startup problems only after a read succeeds, so it can no longer wipe the reason. Before this, Retry could wipe it when pressed before the first read had failed; the review found that. The four tests in `ManagerWindow.test.tsx`:
  - "says why the notes database did not open…";
  - "keeps the reason when Retry is pressed before the first read has failed";
  - "does not hide another problem behind the reason…";
  - "still shows a failed read over an earlier, unrelated startup problem".
  Each was checked against a mutation of the code it guards: reverting the banner choice, clearing on Retry straight away, and always putting the startup reason first.
- `docs/upgrading.md` quoted messages that 0.2.0 and 0.3.0-beta.1 only print to a terminal. It now says what the manager shows. It also says that `gh attestation verify` needs gh 2.49 or newer.
- Already there before this change, not fixed here: a problem added to the manager's list after it opened (`push_error`, e.g. a Settings window that fails to open) never appears. The manager reads the list only once, when it opens.
- The `.deb` lists `libayatana-appindicator3-1` twice in `Depends`. 0.2.0's package does the same. dpkg accepts it; it is harmless and left as is.

## Not checked

| Item | Why |
|---|---|
| `sudo apt install` of the beta over 0.2.0, and apt's "DOWNGRADED" notice when going back | It would replace the owner's installed DeskNotes, which was running |
| The AppImage through FUSE (`./DeskNotes….AppImage` directly) | Extracted instead, so no FUSE library was needed; the app inside is the same |
| A `-wal` file with changes not yet in `desknotes.db` at rollback time | In run D the `mv desknotes.db*` line moved a `-wal` and `-shm`, but they came from read-only checks; their contents were not inspected |
