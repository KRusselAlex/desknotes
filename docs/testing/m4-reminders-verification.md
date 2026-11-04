# Milestone 4 — reminders: verification on Ubuntu

Date: 2026-11-04 · Branch: `feat/m4-reminders` (c47ce70) · Jira: DES-36
Design: `docs/superpowers/specs/2026-11-04-reminders-design.md` (owner's designs R1, R2, R3, B2)

## Machine and conditions

| Item | Value |
|---|---|
| OS | Ubuntu 24.04.5 LTS, GNOME Shell 46 on Wayland; DeskNotes through XWayland (ADR-0002) |
| Build | Release binary (`npm run tauri build -- --no-bundle`), not the `.deb` |
| Data | Isolated scratch folder (`XDG_DATA_HOME`), not the owner's notes. The owner's DeskNotes was quit for the run, with their agreement, and restarted afterwards. |
| Test notes | "Stand-up notes": one-off reminder at 16:09, set 3 minutes ahead. "Bike repair": one-off reminder at 15:56, already due while DeskNotes was closed. Both rows were written into the scratch database before starting. |
| Method | `dbus-monitor` on `org.freedesktop.Notifications`, filtered so only notifications with the app name "DeskNotes" were kept. Nothing from the owner's other apps was recorded. Note windows captured with `import`; the reminders table read with Python `sqlite3`. |

## Checked in the real app

| Check | Result |
|---|---|
| Missed reminder at start | "Bike repair" was sent once, 4 s after start (catch-up) |
| Due reminder while running | "Stand-up notes" was sent at 16:09:00 exactly |
| Notification content | App name "DeskNotes", icon `desknotes`, summary = the note **title** only, empty body. Actions in order: 10 min, 1 h, Dismiss, Tomorrow, plus the default (open the note). Hints: `desktop-entry` "DeskNotes", normal urgency. |
| Sent once each | DeskNotes made exactly 2 `Notify` calls. The xdg-desktop-portal relays each call to GNOME Shell, which is not a second send. `fired_at` equals the due time for both reminders. |
| No re-fire after a restart | Quit and start again: still 2 `Notify` calls 70 s later |
| Bell chip (B2) | "Stand-up notes" shows the bell and "16:09". "Bike repair" shows a red overdue chip with "15:56". |
| Notes untouched | Note text unchanged; only the reminder rows changed |

## Not checked in the real app (owner checks)

| Item | Why |
|---|---|
| The banner as GNOME draws it (three buttons: 10 min, 1 h, Dismiss) and pressing each button; clicking the banner to open the note | Synthetic clicks don't reach GNOME Shell's banners. GNOME 46's three-button limit was read from its source. Button handling is covered by unit tests (stale-button guard, snooze, dismiss). |
| Setting a reminder with the R1 popover and its native date/time inputs | Keyboard and pickers can't be driven here; unit tests cover the popover. |
| The manager's Reminders tab in the real window | Checked in the browser preview, light and dark; unit tests cover grouping and overdue. |
| A private note while locked ("Private note"; title closed from GNOME's list when the lock engages) | Needs a PIN in the scratch data. Unit tests cover the masking and close-on-lock. |
| Sleep/resume and a time-zone change | Not done on the owner's machine. The re-anchor and resume wake are unit-tested. |

## Automated tests at the end of the branch

578 frontend tests, `cargo test --workspace` (core 162, shell 97, others 17), `cargo clippy -D warnings`, `npm run lint` and `npm run typecheck` all pass.
Each task was reviewed separately, then the whole branch; findings were fixed and re-reviewed.
