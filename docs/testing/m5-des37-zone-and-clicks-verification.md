# DES-37 — zone changes with the same offset, and clicked notifications

Date: 2026-11-13 · Branch: `fix/des-37-zone-and-clicked-notifications` · Jira: DES-37

## Machine and conditions

| Item | Value |
|---|---|
| OS | Ubuntu 24.04.5 LTS, GNOME 46 on Wayland. The system zone is Africa/Porto-Novo (UTC+1, no summer time). |
| Builds | Release binaries (`npm run tauri build -- --no-bundle`): "before" was built without the 1.1 s wait (the review's finding below) and "after" with it. Both have the zone-name check and the click change. |
| Isolation | Each run used its own user and mount namespace (`unshare -rm`). `/etc` was an overlay whose writes went to a scratch folder, so the zone changed for DeskNotes only: the real `/etc/localtime` stayed Porto-Novo throughout. Each run also had a hidden X display (`Xvfb :78`), a private D-Bus session, and a scratch `HOME` and runtime folder. The owner's DeskNotes kept running untouched. |
| Notification service | A fake `org.freedesktop.Notifications` on the private bus (Python, Gio) recorded every `Notify` and `CloseNotification` and sent the clicks. "Gnome" got a 10 min click followed by `NotificationClosed`, as GNOME does. "Keep" got the same click and stayed on screen, as on desktops that keep clicked notifications. |
| Data | Four notes written into the scratch database: "Keep", "Gnome" and "Race" with one-off reminders 2 min overdue, and "Zone" with 1 June 2027 09:00 (08:00 UTC in Porto-Novo). The rows were read in read-only mode. |

## Runs

The fake service played the same script in every run, timed from the "Keep" notification:

1. "Gnome" is clicked at 1.5 s.
2. "Keep" is clicked at 3 s.
3. The namespace's zone switches to Europe/Paris at 3.3 s. Paris is UTC+1 today, like Porto-Novo, but uses summer time from March.
4. "Race" is clicked at 3.6 s.

The click on "Race" makes a pass run less than a second after the one the "Keep" click caused. chrono's `Local` reuses its zone without checking `/etc/localtime` for up to 1 s, so this pass is the race the review described.

| Check | Before | After |
|---|---|---|
| Catch-up at start | 3 notifications, one per note | Same |
| "Gnome" clicked, then closed by the service | Snoozed; no `CloseNotification` from DeskNotes | Same |
| "Keep" clicked, left on screen | Snoozed; DeskNotes closed it at the next pass (`CloseNotification`, still open) | Same |
| "Zone" after the switch to Paris (same offset today) | **Still 08:00 UTC** 70 s after the switch, with at least one more pass. The change was recorded with the old rules and never re-anchored. | **07:00 UTC**, which is 09:00 Paris summer time. The pass after the switch waited 1.1 s: "Race" was closed 1.1 s after its click, against 2 ms for "Keep". |
| The real `/etc/localtime` afterwards | Africa/Porto-Novo | Africa/Porto-Novo |

## Found while testing

- **Review finding, confirmed in the "before" run.** The zone name is read fresh each time, but chrono's `Local` keeps its zone for up to a second per thread. A pass in that second recorded the new name while it re-anchored with the old rules, and no later pass tried again. Fix: when the name changes, the scheduler waits 1.1 s before reading `Local`. This happens once per zone change, on its own thread.
- **The extra close after a click, on GNOME.** After a Snooze or Dismiss, DeskNotes now also asks to close the clicked notification, in case the desktop kept it. GNOME Shell 46 has usually closed it already. Its `CloseNotification` ignores an unknown id without an error (read from `notificationDaemon.js` in `libshell-14.so`), so nothing is logged. In these runs the service's own `NotificationClosed` came first, and DeskNotes sent no second close.

## Not checked

| Item | Why |
|---|---|
| Real GNOME banners: pressing a button and clicking the banner | Synthetic input does not reach GNOME Shell's banners; still an owner check from DES-36 |
| The privacy lock closing a clicked notification that is still on screen | Needs a PIN set up through the UI. Covered by the unit test `a_clicked_notification_is_kept_so_the_lock_can_still_close_it`. |
| A zone change on the real system (Settings → Date & Time) | It would change the owner's computer. The namespace switch replaces `/etc/localtime` the same way timedated does. |
| A desktop that really keeps clicked notifications (KDE, some others) | Not installed; played by the fake service |
