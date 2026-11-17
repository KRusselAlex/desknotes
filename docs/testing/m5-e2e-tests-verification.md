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
| Privacy lock, settings, backup | Later suites |

The CI job ran the three tests on PR #53 against the debug build: they passed in 12.7 s.

# DES-6 — end-to-end tests: reminders

Date: 2026-11-17 · Branch: `test/des-6-e2e-reminders` · Jira: DES-6

Same machine, tools and isolation as above, plus `python3-gi` for the stand-in
notification service. Builds: release and debug (frontend embedded) of `main` at 62e4039,
with no app changes.

## What the suite covers

`tests/e2e/reminders.e2e.ts`, two tests on the real clock (about 2 minutes, mostly
waiting for a minute to come):

1. Three notes get reminders for the same minute, set from the popover with the time
   typed as "HHMM". Nothing is sent early. When due, three notifications come: the
   summary is the note's title, the body is empty, the buttons are 10 min, 1 h, Dismiss,
   Tomorrow (and the click), the desktop entry is DeskNotes, and no other line of the
   notes is sent. A click opens the note that was hidden. "10 min" moves its reminder to
   ten minutes from the click, "Dismiss" removes a one-off, and the opened note's
   reminder shows as overdue in the Reminders tab.
2. Seven reminders come due while DeskNotes is closed. At the next start come five
   notifications with the reminder buttons, and one "2 more reminders" with only the
   click, which shows the manager (hidden at start, since notes are open). None carries
   the notes' second lines, and the Reminders tab lists all seven as overdue.

## How

- `tests/e2e/notifications.py` (Python, Gio) owns `org.freedesktop.Notifications` on the
  private bus, records every call, and clicks buttons the way GNOME does
  (`ActionInvoked`, then `NotificationClosed`).
- DeskNotes runs in a fixed time zone where it is about 10:00 (`TZ=Etc/GMT±N`), so a
  reminder a minute away is today at any hour and the popover starts on its date.
  The first test checks that the note window uses the same zone as the tests.

## Runs

| Check | Result |
|---|---|
| Release build, reminder suite | Passed (133 s) |
| Release build, whole e2e suite, twice | 5 of 5 passed both times (171 s, 124 s) |
| Debug build (what CI runs), whole e2e suite | 5 of 5 passed (124 s) |
| Release build, whole suite, after the review fixes | 5 of 5 passed twice (191 s, 201 s) |
| One more run | Test 1 failed: the laptop lid was closed and the computer slept mid-test (`systemd-logind`, 15:10:30). Not counted |
| After every run | No scratch folder or test process left |

## Mutation checks

Built into a debug app, run, reverted.

| Mutation | Caught by |
|---|---|
| Missed reminders capped at 10 instead of 5 | Test 2: 7 notifications instead of 6 |
| "10 min" snoozes for an hour | Test 1: "11:29" instead of "10:39" |
| The notification body repeats the title | Test 1: "a reminder shows the title only" |
| A click on a reminder opens nothing | Test 1: the note's window never came back |
| A click on the summary shows nothing | Test 2: the manager never came on screen |

## Found while testing

- **Ctrl+A does not select through WebKitWebDriver.** The digits typed after it were
  lost, and the reminder kept its default time. The tests clear the field with Backspace.
- **WebDriver cannot type into WebKitGTK's date field.** It is filled part by part, in
  the locale's order ("2027-03-04" became "0004-12-03"). Hence the fixed morning zone.
- **"Hide note" closes the note's window** (it is not just hidden). A click on the
  reminder opens a new one.
- The time field takes "1024" as 10:24 through real key presses, which covers the DES-45
  fix end to end.

## Review (desknotes-reviewer)

No data-loss, privacy or real-session problem: the stand-in and the time zone stay on
the private bus and in the test app. Fixed after the review:

- a failed quit no longer leaves the stand-in owning the name for the next test, and a
  stand-in that fails to start is stopped;
- the stand-in refuses to start outside `run.sh`, and `run.sh` checks that Python can
  import `gi`;
- each test checks it set its reminders with time to spare (3 s, and 15 s before the
  quit in test 2), and test 2 leads by 60 s;
- the "10 min" check reads the clock around the app's own snooze, not around the click;
- test 2 also checks bodies, second lines, and the seven overdue rows.

## Not covered

| Item | Why |
|---|---|
| GNOME's own banners and buttons | Drawn by GNOME; the stand-in records what is sent |
| "Private note" while locked | The privacy-lock suite |
| Snooze "1 h" and "Tomorrow", repeats, time-zone and sleep changes | Unit tests in `src-tauri/src/reminders.rs` and the core |
