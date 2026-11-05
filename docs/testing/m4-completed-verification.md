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

On 2026-11-05 the owner installed the .deb built from `main` (installed 18:21) and confirmed "is ok". Their database is at schema 7 and has one note marked done. Only metadata was read, read-only.

## Not checked in the real app

| Item | Why |
|---|---|
| Ctrl+D, and Ctrl+Z / Undo on the strip | Synthetic keys don't reach the windows under Wayland. Unit tests cover them. |
| Quit, lock, hide-all and export while the strip shows | Not run. Rust and unit tests cover the round being answered before the window closes. |
| Move to trash from the Completed tab, then restore | Unit-tested |
| A destroy failure after the database write (the note stays open but is marked done) | Very unlikely; recorded here as known (final review M6) |

## Automated tests

655 frontend tests (3 runs), `cargo test --workspace`, `cargo clippy -D warnings`, `npm run lint` and `npm run typecheck` all pass. One run failed once in an unrelated, pre-existing test (`ForgotPin.test.tsx`); it is tracked in Jira.
Each task was reviewed separately, then the whole branch; findings were fixed and re-reviewed.
