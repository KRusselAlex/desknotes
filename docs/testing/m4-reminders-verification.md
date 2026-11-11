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

## The R1 popover's time field (DES-45, 2026-11-08)

The owner found that the time could not be set.

**Cause.** WebKitGTK 2.52 draws `<input type="time">` as segments, and its hour segment never moves on to the minutes by itself. Each digit replaces the hour, so typing "0930" left "12:00". A plain input on a bare WebKitGTK page, with no React involved, does exactly the same. The minutes were reachable only with Tab, the Right arrow or a click on them.

**Fix.** The time is now a typed text field. Checked on a release binary of `fix/reminder-time-input`. **Isolation:**
- a hidden screen: Xvfb with no window manager;
- a private D-Bus;
- a scratch `HOME`.

The owner's DeskNotes kept running and was untouched. **Method:** libxdo keys and clicks, window screenshots, and the database read with Python `sqlite3`.

| Check | Result |
|---|---|
| Open ⋯ → Set reminder… | The popover shows the date and "05:00" (the next whole hour) |
| Type "0930" into the time field | All four digits are kept, and leaving the field shows "09:30" |
| Type "9:30 pm" | Shows "21:30" once the field is left |
| Type "25:00" | The field gets the red border and Save is disabled |
| "0930", then Save | The popover closes, and the database has 2026-11-08 09:30, repeat none. The note's chip shows "09:30". |

**Owner check (2026-11-08).** On the .deb of main 56d437e, which includes the later review fixes ("14h", and red only once the field is left), the owner reports that typing the time works. Checked against the machine:
- the running DeskNotes was started at 10:25 from the installed binary, which is byte-for-byte the one in that .deb;
- a new reminder was saved after that: 2026-11-30 06:00, repeat weekdays. The popover's default would have been the next whole hour (about 11:00), so the time was typed.

The first report ("still broken") came from a DeskNotes started at 04:32 from the old .deb, which was still running after the reinstall. A new launch only hands over to the running copy, so the update shows only after Quit from the manager.

## Not checked in the real app (owner checks)

| Item | Why |
|---|---|
| The banner as GNOME draws it (three buttons: 10 min, 1 h, Dismiss) and pressing each button; clicking the banner to open the note | Synthetic clicks don't reach GNOME Shell's banners. GNOME 46's three-button limit was read from its source. Button handling is covered by unit tests (stale-button guard, snooze, dismiss). |
| The date field's calendar picker | Not opened here. The date field is native; the owner reports it works, and the reminder they set on 2026-11-08 has a date picked weeks ahead. |
| The manager's Reminders tab in the real window | Checked in the browser preview, light and dark; unit tests cover grouping and overdue. |
| A private note while locked ("Private note"; title closed from GNOME's list when the lock engages) | Needs a PIN in the scratch data. Unit tests cover the masking and close-on-lock. |
| Sleep/resume and a time-zone change | Not done on the owner's machine. The re-anchor and resume wake are unit-tested. |

## Automated tests at the end of the branch

578 frontend tests, `cargo test --workspace` (core 162, shell 97, others 17), `cargo clippy -D warnings`, `npm run lint` and `npm run typecheck` all pass.
Each task was reviewed separately, then the whole branch; findings were fixed and re-reviewed.

## DES-37 batch 1: owner decisions and scheduler fixes (2026-11-09)

Owner decisions (2026-11-09):
- GNOME's three buttons stay 10 min, 1 h, Dismiss.
- In the Reminders tab, a locked private note's row shows its private label.
- The five-notification cap applies after waking from sleep too.
- (2026-11-11) A restore gets the same cap: what is due in the restored notes comes
  as five notifications plus a summary. Unit tests only, as for sleep.

Debug build of `fix/des-37-reminders`, hidden X display, scratch HOME. The throwaway
database had a PIN set (so the lock was on at start) and three hidden notes with reminders
on 20 Nov: a private note labelled "Bank", a private note with no label, and "Dentist".

| Check | Result |
|---|---|
| Reminders tab rows | "Bank", "Private note", "Dentist"; no note text |
| Search "secret" (words only in the private notes' text) | "No reminders match your search" |
| Search "bank" | The "Bank" row only |

Not checked in the real app (unit tests only):
- The cap after a real sleep and resume. It needs logind's sleep signal on the system bus.
- Notifications closing after a restore. Clicks do not reach the Settings window here.
- A new summary replacing the old one.
- The export notice for a damaged reminder.

Review findings fixed in this batch (unit tests, each failing without its fix):
- **Restore while a pass is sending, or waiting for the database.** The send is closed
  and not recorded, or is sent from the new database and kept.
- **Sleep noticed from the clocks** when the resume signal comes late.
- **A fire dropped because the reminder changed** still reaches rule 2.
- **A note left out of an export** is reported once.

## DES-37 batch 2: tests, tidy-ups and the note window theme (2026-11-11)

Debug build of `fix/des-37-batch2`, hidden X display, scratch HOME, started with
`GTK_THEME=Adwaita:dark` so WebKit reports a dark system theme. The throwaway database held
one note with a link and an overdue reminder.

| Check | Result |
|---|---|
| Manager | Dark (the system theme reached WebKit) |
| The note, opened from the manager | Light: yellow note, dark link ink, the overdue chip light red with white text, light window controls. No dark-theme peach anywhere in the capture |

Not checked in the real app: the keyboard focus ring inside the note (Tab did not show one in
the capture), and popovers and dialogs opened in a note under the dark theme. Unit tests cover
the theme choice per window.

The Reminders tab's groups are now separate lists named by their labels. This was checked
only by unit tests: the look is unchanged by design.
