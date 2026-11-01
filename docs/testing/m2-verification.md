# Milestone 2 — verification on Ubuntu

Machine and method as in `m1-verification.md` (Ubuntu 24.04 GNOME, XWayland, debug build,
isolated test data, `scripts/verify/`).

## Always on top (design B2) — 2026-11-01

| Check | Result |
|---|---|
| Pin button in the header turns it on | `_NET_WM_STATE_ABOVE` set on the window by Mutter; saved in the database |
| Pin stays visible while reading; click turns it off | Matches design B2 (screenshot checked) |
| "Always on top" in the ⋯ menu | Checkbox item reflecting the current state (unit test) |
| Restart | Note reopens with `_NET_WM_STATE_ABOVE` |

## Collapse to header (design B3) — 2026-11-01

| Check | Result |
|---|---|
| Collapse from the header chevron | Window 300 × 32; database keeps the expanded height 280 |
| Expand from the strip chevron | Window back to 300 × 280 |
| Restart while collapsed | Reopens as a 300 × 32 strip |
| Text typed before collapsing | Saved first; collapsing is refused while a save is failing (unit test) |

Found while testing: a non-resizable GTK window is forced to its content's natural size
(300 × 200 for a WebKit view), so the strip first came up 200 px tall. Collapsed windows
now stay resizable with equal minimum and maximum heights (32 px).

Not checked yet: double-clicking the strip to expand with the real mouse.

## Settings window: General and About (designs S2, S4) — 2026-11-01

| Check | Result |
|---|---|
| Manager ⋯ → Settings… | Opens a 680 × 520 "Settings" window; it shares the single WebKit process |
| Launch at login on | Writes `~/.config/autostart/DeskNotes.desktop` (Exec = the running binary) |
| Launch at login off | Removes that file; other apps' entries (`xpad.desktop`) untouched |
| Colour for new notes = Mint | The next new note is created `#c8f7c5` |
| About | Version, "MIT license", data folder path, "No data leaves this computer." |

Not checked in the real app: "Open folder" (it opens the file manager; covered by a unit
test). Privacy, Appearance and Backup sections will appear as those features are built.
