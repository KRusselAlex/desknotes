# Milestone 4 — completed notes: verification on Ubuntu

Date: 2026-11-05 · Branch: `feat/m4-completed` (0d2c493) · Jira: DES-39
Design: `docs/superpowers/specs/2026-11-05-completed-notes-design.md` (option A, chosen by the owner)

## Machine and conditions

| Item | Value |
|---|---|
| OS | Ubuntu 24.04.5 LTS, GNOME 46 on Wayland; DeskNotes through XWayland (ADR-0002) |
| Build | Release binary (`npm run tauri build -- --no-bundle`) |
| Data | Isolated scratch folder. The owner's DeskNotes was quit with their agreement, and the owner stayed off the mouse and keyboard during the run. DeskNotes was restarted afterwards. |
| Test notes | "Groceries" with a one-off reminder at 18:09 (3 minutes ahead), and "Bike repair" |
| Method | Clicks with libxdo, window screenshots, the database read with Python `sqlite3`, and a `dbus-monitor` filtered to DeskNotes notifications only |

## Checked in the real app

| Check | Result |
|---|---|
| ⋯ menu | "Mark as done" sits right after "Set reminder…" in the option-B list |
| Mark as done | The "Marked done" strip with **Undo** shows under the header; the note's text doesn't move |
| After 5 s | The Groceries window closed. The database has `completed_at` set; content and window geometry are unchanged; Bike repair is untouched. |
| Manager tabs | Active 1 · Completed 1 · Reminders (no count: the done note's reminder is hidden) · Archived · Trash |
| Completed tab | Groceries · "Done 06:07 PM" (the system locale is 12-hour, like the other tabs) · **Reopen** |
| Reminder while done | No notification at 18:09: 0 DeskNotes `Notify` calls |
| Reopen | The Groceries window came back at 130,96, 300 × 280. In the database `completed_at` is NULL and `visible` is 1. |
| Reminder after Reopen | The overdue Groceries reminder fired once ("Groceries") |
| Restart | Both notes opened again at their saved places |

## Owner's check

On 2026-11-05 the owner installed the .deb built from `main` (built 18:21, installed 18:32 per `/var/log/dpkg.log`) and confirmed "is ok". Their database is at schema 7 and has one note marked done. Only metadata was read, read-only.

## Hardening checks (DES-40, 2026-11-08)

Release binary of `fix/des-40-hardening`. **Isolation:**
- a hidden screen: an `Xvfb` display with no window manager;
- a private D-Bus daemon;
- a scratch `HOME`.

The owner's DeskNotes and desktop were untouched. **Method:**
- keyboard focus with libxdo (`xdo_focus_window`), then synthetic keys and clicks;
- window screenshots;
- the database read with Python `sqlite3`.

There was no tray (no StatusNotifier host on the private bus). Hide-all and show-hidden came from `desknotes --toggle-notes`, the command the GNOME shortcut runs. Quit came from the manager's ⋯ menu.

| Check | Result |
|---|---|
| Ctrl+D | The "Marked done" strip shows, with Undo |
| Ctrl+Z while the strip shows | The strip goes. 7 s later the note is open and active, and its text is unchanged. |
| Undo button | Worked in 8 of 9 tries: the strip goes, the cursor is back in the text, and 6 s later the note is open and active. It worked with and without the button's focus ring, and as the session's very first click. In the first try the note was marked done after 5 s instead. Six repeats of exactly those steps all worked, so the miss is not reproduced and its cause is unknown (a lost synthetic click is likely, not proven). **Owner check:** passed 2026-11-08 with the real mouse, on the `.deb` of main 56d437e (running since 10:25 from that binary). Undo leaves nothing in the database, so the owner's report is the evidence. |
| Hide-all while the strip shows | The strip's note was marked done and is not in the hide-all list. The three other notes were hidden and remembered. Show-hidden brought back those three, not the done one. |
| Quit while the strip shows | Quit was clicked 2.3 s after Ctrl+D. The app exited about 1 s later, and the note is marked done. |
| Restart afterwards | Only the two active notes opened; the three done notes stayed closed. No errors in the log. |

## Not checked in the real app

| Item | Why |
|---|---|
| Lock and export while the strip shows | Not run: lock needs a PIN set up, and export needs the file chooser. They use the same note-window round as quit and hide-all (`onSaveAllRequest`), which was checked above. |
| A stale Reopen click on a note that is not done (DES-40) | Needs a Completed list drawn before the note was reopened elsewhere; unit-tested in the core (`reopening_a_note_that_is_not_done_changes_nothing`) |
| Note settings refused for a done, archived or trashed note (DES-40) | Not reachable from the UI except for the moment before a done note's window closes; unit-tested (`only_a_note_that_may_have_a_window_gets_one_or_its_settings`) |
| Move to trash from the Completed tab, then restore | Unit-tested |
| A destroy failure after the database write (the note stays open but is marked done) | Very unlikely; recorded here as known (final review M6) |

## Automated tests

655 frontend tests (3 runs), `cargo test --workspace`, `cargo clippy -D warnings`, `npm run lint` and `npm run typecheck` all pass. One run failed once in an unrelated, pre-existing test (`ForgotPin.test.tsx`); it is tracked in Jira.
Each task was reviewed separately, then the whole branch; findings were fixed and re-reviewed.
