# ADR-0002: Use XWayland for note windows on Linux Wayland sessions

Status: Accepted, pending verification on the development machine · 2026-11-01

## Context
Sticky notes need to restore their position, and to stay above other windows.
Native Wayland gives clients no way to set a global window position, read it, or
request "always on top" (the wayland-protocols proposal for this is unmerged).
GTK on Wayland therefore ignores `move()` and `set_keep_above()`. The development
machine runs Ubuntu 24.04 GNOME on Wayland.

## Decision
On Linux, if the session is Wayland and neither `GDK_BACKEND` nor
`DESKNOTES_BACKEND=wayland` is set, DeskNotes sets `GDK_BACKEND=x11` at the very start
of `main()`, before GTK initializes. Windows then run under XWayland, where Mutter
honours positions and the keep-above hint.

`DESKNOTES_BACKEND=wayland` opts into native Wayland. In that mode the app reports
position restoration and always-on-top as unsupported instead of pretending.

## Consequences
- Expected to make positioning and always-on-top work on GNOME. Must be verified by
  running the build; the result is recorded in `docs/testing/`.
- Fractional scaling can blur XWayland windows. Integer scaling is unaffected.
- If a future Ubuntu release drops XWayland by default, this ADR must be revisited
  (for example, a GNOME Shell extension companion).
- Windows and macOS are unaffected; the logic is compiled only on Linux.
