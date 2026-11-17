# DES-6 — end-to-end tests: first suite

Date: 2026-11-17 · Branch: `test/des-6-e2e` · Jira: DES-6

## Machine and conditions

| Item | Value |
|---|---|
| OS | Ubuntu 24.04.5 LTS, GNOME 46 on Wayland |
| Tools | WebKitWebDriver 2.52.6 (`webkit2gtk-driver`, same version as the app's WebKitGTK), tauri-driver 2.1.0, Xvfb, Node 24.11 |
| Builds | Release (`npm run tauri build -- --no-bundle`) and debug with the frontend embedded (`npm run tauri build -- --debug --no-bundle`, what CI uses), both from this branch with no app changes |
| Isolation | `scripts/e2e/run.sh`: a hidden Xvfb display, a private D-Bus session, scratch home, config, cache, state and runtime folders, GSettings in memory. The owner's DeskNotes was not running (not started since the 15 November reboot); its database was not opened. |

## What the suite covers

`tests/e2e/notes.e2e.ts`, three tests, about 11 s in all:

1. First start: the welcome note opens in its own window, the manager lists it, and the
   database is in the test's data folder.
2. A note made with "New note" and typed into is saved (the manager's search finds its last
   word). No X11 window name contains its text. After a restart its window reopens with the
   same paragraphs. The manager starts hidden, and opening DeskNotes again shows it.
3. "Move to trash" closes the note's window and the note leaves the Active list. "Restore"
   in the Trash tab brings it back to Active.

## Runs

| Check | Result |
|---|---|
| Release build, first version of the suite | 5 runs out of 5 passed (about 13 s each) |
| Release build, after the review fixes | 3 runs out of 3 passed (about 11 s each) |
| Debug build, after the review fixes | Passed |
| `vitest run --config vitest.e2e.config.ts` without `run.sh` | Refused before any app started |
| After every run | No scratch folder, FUSE mount or test process left |

## Mutation checks

Each mutation was built into the app, the suite was run, and the mutation was reverted.

| Mutation | Caught by |
|---|---|
| `trash_note` no longer closes the note's window (release build) | Test 3: "the note window to close" timed out |
| Autosave never schedules a save (release and debug builds) | Tests 2 and 3: the save checks timed out |
| The note window's title is set to the note's title on save (debug build) | Test 2: the X11 window name was "Shopping list" |

## Found while testing

- **WebDriver reaches every window.** WebKitGTK logs "is-controlled-by-automation can't
  be set when related-view is set" for each note window. Note windows share the manager's
  web process (ADR-0006). They are still listed as window handles and can be driven.
- **The manager starts hidden when notes are open** (`manager_shown_at_startup`). WebDriver
  will not click in a hidden window. The tests open the manager the way the app menu does:
  they start the binary again, and single-instance hands over.
- **Stopping tauri-driver too early leaves DeskNotes running.** If tauri-driver stops
  before WebKitWebDriver has ended the app, the app is left orphaned. `quit()` now waits
  for the app to exit before stopping the driver.
- **The private bus's portals mount FUSE folders** (`run/doc`, `run/gvfs`) in the
  scratch runtime folder. `run.sh` unmounts them before removing the folder.

## Review (desknotes-reviewer)

The reviewer watched a live run. It found no path to the owner's data or desktop when the
tests run through `run.sh`: the environment, D-Bus services, mounts, dconf and autostart
all stayed in scratch. Fixed after the review:

- a guard against running without `run.sh`;
- a lock so runs take turns, a display picked by Xvfb, free ports, and only this run's
  processes counted;
- cleanup when a launch fails, timeouts on requests, and a time limit on the CI job;
- the real X11 window title instead of the HTML `<title>`;
- a save proved through the database before quitting;
- hovers confirmed;
- checks that wait for a positive state;
- proof that the hidden-manager path and the per-launch data folder are used.

Left as is: the test app still reaches the real system bus, for the logind sleep inhibitor
and the screen-lock signal.

## Not covered

| Item | Why |
|---|---|
| Tray menu, notification banners, header drags, keyboard layout | Drawn by GNOME, not the webviews; `scripts/verify/` and owner checks |
| The CI job itself | Runs on the pull request |
| Reminders, privacy lock, settings, backup | Later suites |
