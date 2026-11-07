# Milestone 4 — automation rules: verification on Ubuntu

Date: 2026-11-07 · Branch: `feat/automation-rules` (verified at 94f7c80, stacked on PR #25) · Jira: DES-42
Design: `docs/superpowers/specs/2026-11-06-automation-rules-design.md`

## Machine and conditions

| Item | Value |
|---|---|
| OS | Ubuntu 24.04.5 LTS, GNOME 46 on Wayland |
| Build | Release binary of this branch (`npm run tauri build -- --no-bundle`) |
| Isolation | **Hidden screen:** an `Xvfb` display, 1920 × 1080, with no window manager. **Private message bus:** a separate D-Bus daemon. **Throwaway data:** a scratch `HOME`, so `~/.local/share/io.github.krusselalex.desknotes/` was throwaway. The owner's DeskNotes and notes were untouched. |
| Notifications | A small stand-in `org.freedesktop.Notifications` service on the private bus. It accepts notifications without showing them, so reminders could fire. |
| Test data | A Python script wrote these notes into the **scratch** database: <br>• A, done 8 days ago, and B, done 6 days ago<br>• C, trashed 31 days ago, and D, trashed 29 days ago<br>• E, "Groceries": a checklist with one item ticked, window open<br>• F, "Morning routine": both items ticked, a daily reminder due a minute ago, window open<br>• G, "Weekly list": the same as F, but window closed<br><br>All four rules were on, with 7 and 30 days. |
| Method | Clicks with libxdo, screenshots with `import`, and the database read with Python `sqlite3` in read-only mode |

## Checked in the real app

| # | Check | Result |
|---|---|---|
| A1 | Start-up run of rules 3 and 4 | The log reads "automation rules archived 1 and deleted 1 notes". **A** was archived; **B** (6 days) was not. **C** was deleted for good; **D** (29 days) was kept. The manager shows Archived 1 and Trash 1. |
| A2 | Rule 2 on start-up, window closed (**G**) | Both reminders fired (the stand-in service got 2 notifications). G's stored checklist went from `xx` to `__`. |
| A3 | Rule 2 on start-up, window open (**F**) | F's checklist went from `xx` to `__`. A second run, with F's reminder due again and the window restored at start-up, caught the strip **"Checklist reset for this reminder"** with **Undo** on screen. It then faded, leaving the list unticked. This is the "window not ready yet" case: the reset waits as pending and the note claims it once it has loaded. |
| A4 | Rule 1: tick the last unticked item of **E** | The strip **"Marked done · every item is ticked"** with **Undo** shows. After 5 s, E is completed (`completed_at` set) and its window closes. |
| A5 | Rule 1 skips routines: tick every item of **F** (daily reminder) | F stays active and fully ticked. It is not marked done (owner decision 2026-11-06). |
| A6 | Settings → Automations | It matches the approved mockup: the clock icon between Appearance and Privacy, the intro line, four rows with the exact copy, the day fields (7, 30) and row 4's danger-ink line. |
| A7 | Rule 4 off, then on | Off saves at once (`purge_trash_enabled` removed, days kept). On shows **"Empty old trash?"** with "…more than **30 days**… There are no such notes right now." (D is 29 days), plus Cancel and Turn on. **Cancel** leaves it off and nothing is deleted. |

## Not checked in the real app

| Item | Why |
|---|---|
| Undo on each strip | The strips' Undo is covered by unit tests. Synthetic clicks on the strip within its 5 s window were not attempted on the hidden screen. |
| The rule 4 dialog with K > 0 and with a days change | Covered by the Settings tests (counts 4 → 6). Not repeated in the real app. |
| A restore turning rule 4 off, and the Settings window updating | Covered by the core and Settings tests (`restore_turns_purge_off_and_keeps_days`, `set_automations_never_turns_purge_on`, and the restore event test). The restore emit needs an app handle and has no unit test. |
| Locked private notes are skipped by every rule | Covered by the core test `rules_skip_locked_private_notes` |
| The hourly run, and the run after unlocking | The timer was not waited for. Covered by `run_rules` tests and by reading the code. |
| Focus after rule 1 on the owner's desktop (WebKitGTK may give focus back to the editor) | It needs a real desktop. **Owner check:** tick the last item with the mouse, then press Space. Undo should not be typed into the note. |

## Automated tests

`npm test`, `npx eslint src`, `npm run typecheck`, `cargo test --workspace`, `cargo clippy -D warnings` and `cargo fmt --check` pass.
- Every task was reviewed separately, and every fix round was re-reviewed.
- `npm run lint` currently also scans other sessions' git-ignored worktrees under `.claude/worktrees/` and fails there. Linting `src` is clean.
