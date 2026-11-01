# Milestone 1 — verification on Ubuntu

Date: 2026-11-01 · Branch: `feat/m1-core`

## Machine and conditions

| Item | Value |
|---|---|
| OS | Ubuntu 24.04.5 LTS, x86_64 |
| Session | GNOME on Wayland; DeskNotes windows run through XWayland (ADR-0002) |
| WebKitGTK | 2.52.6 |
| CPU / RAM | 14 threads / 30 GiB, Intel Meteor Lake graphics |
| Build | debug build with the Vite dev server unless noted |
| Data | isolated test folder (`XDG_DATA_HOME`), not the owner's notes |
| Method | simulated input with `scripts/verify/` (libxdo), window geometry from `xwininfo`, database read with `scripts/verify/db.py`, screenshots of the real windows |

## Acceptance criteria

| Criterion | Result | Evidence |
|---|---|---|
| Launch on Ubuntu | **Pass** | First launch with no notes opens only the manager (560 × 620, centred), empty state as designed. |
| Create a note and type | **Pass** | "New note" opens a 300 × 280 note at the cascade position; typed text, bold and a checklist appear. |
| Saved locally | **Pass** | SQLite row updated after typing (title derived: "Weekend errands"). |
| Close and reopen without losing content | **Pass** | Quit from the manager menu, relaunch: title, bold word and checklist restored exactly. |
| Move | **Pass** | Dragging a note by its header with the real mouse works (confirmed by the owner). A window-manager move to 520, 240 was saved exactly and restored after restart. |
| Resize | **Pass** | Resized to 360 × 340; saved and restored exactly after restart. |
| Position and size restored | **Pass** | After restart: window at 520, 240, size 360 × 340, matching the database. |
| Change colour | **Pass** | Picker → Mint saved as `#c8f7c5` and restored after restart. |
| Formatting kept after restart | **Pass** | Bold and checklist intact after restart. |
| Works offline | **Pass by design** | The app makes no network requests (the debug build only talks to the local dev server; release builds embed the UI). |
| No known critical data-loss bug | **Pass after fixes** | Two bugs found and fixed during this run (below). |
| Rebuild from instructions | **Pass** | Built from the README package list and CONTRIBUTING commands. |
| Automated tests | **Pass** | 31 core tests, 43 frontend tests, clippy and ESLint clean. |

Other checks:

| Check | Result |
|---|---|
| Hide note (✕) | Window closes, note saved as hidden, manager appears so the app stays reachable. |
| Show again from the manager | Note reopens at its saved place and size. |
| Second launch while running | Exits immediately; still one DeskNotes process (single instance). |
| Opening a note does not modify it | Pass after fix (below); "edited" time unchanged by opening or clicking. |

## Bugs found by running the real app

1. **Notes grew 37 px taller on every restart.** tao maps a window before removing its
   decorations, so Mutter framed it with a title bar first and the note kept that
   height. Fixed by creating note windows hidden and showing them afterwards
   (`src-tauri/src/windows/mod.rs`). Measured after the fix: 300 × 280 on screen and in
   the database, no frame extents.
2. **Opening or focusing a note saved it.** Tiptap's trailing-paragraph extension and
   `setEditable` emitted updates; fixed and covered by a test.

## Fixes from the pre-merge review, retested in the real app

| Change | Real-app result |
|---|---|
| Hide, archive or trash from the manager now asks the note window to save first and act itself | Typed text, then immediately hid the note from the manager: text saved, note hidden. |
| Quit waits for every note to confirm it saved, and is cancelled if one cannot | Typed text, then immediately quit: text saved, app exited, note reopens next launch. The cancel path is covered by unit tests (`src-tauri/src/quit.rs`, `NoteWindow.test.tsx`). |
| Note windows cannot be maximised | Double-clicking the header no longer maximises the note. |
| Tauri 2.11 → 2.12 (minimum Rust 1.90) to match the JavaScript packages | New notes still open at exactly 300 × 280. |
| Content the editor cannot load is shown as "could not be opened" and never saved over | Unit tests only. |

## Resources

PSS (proportional memory, shared libraries split fairly) per process, idle CPU over 10 s.

| Build | Open windows | Total PSS | Per extra note | Idle CPU |
|---|---|---|---|---|
| debug + dev server | manager + 1 note | 294 MiB | — | 0.2 % |
| debug + dev server | manager + 10 notes | 1005 MiB | ≈ 80–90 MiB | 3.2 % (just after opening) |
| **release** | 10 notes | 1062 MiB | ≈ 80–90 MiB | ≈ 2 % of one core after settling |
| **release** | 30 notes | 2390 MiB | ≈ 80 MiB | 5.3 % (just after opening) |

Release startup, from launch to all 10 note windows on screen: **1.4 s**.
Release binary size: 9.7 MB.

Settled idle CPU per process (release, 10 notes): main process ≈ 0.8 %, the focused
note ≈ 0.8 % (blinking cursor), every other note ≈ 0.05 %.

**Finding:** each window got its own WebKit web process (≈ 80 MiB). CPU is fine, but
memory was too high for 30 visible notes (2.4 GB). Addressed in ADR-0006 (below).

## Checked by the owner

- Dragging a note by its header with the real mouse: works.

## Still open

- Resizing from the window edges with the real mouse was not checked separately
  (programmatic resize is saved and restored).

## Shared web process (ADR-0006), 2026-11-01

Same machine, debug build with the dev server, so comparable with the first two rows above.

| Open windows | Before (separate processes) | After (shared process) |
|---|---|---|
| manager + 1 note | 294 MiB, 4 processes | 261 MiB, 3 processes |
| manager + 10 notes | 1005 MiB, 13 processes | 446 MiB, 3 processes |
| about 30 notes | 2390 MiB, 33 processes (release) | 737 MiB, 3 processes (28 notes, debug) |

Restart with 28 visible notes: all restored at 300 × 280 in 2.2 s (debug build), still one
web process. Typing in a note after the change still saves. Idle CPU 1.7–2.5 % right
after opening.
