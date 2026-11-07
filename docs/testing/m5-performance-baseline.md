# Milestone 5 — performance baseline

Date: 2026-11-07 · Build: release binary of `main` at 3b549a7. This includes images in notes, the automation rules and window-scoped events. · Jira: DES-44
Plan: `docs/design.md` §8. Earlier numbers: `docs/testing/m1-verification.md` and ADR-0006.

These are the reference numbers later releases are compared against. Re-run the same steps after any change to windows, the editor or start-up.

## Machine and conditions

| Item | Value |
|---|---|
| Machine | Intel Core Ultra 7 155U (14 threads), 31 GiB RAM, Linux 7.0.0-42 |
| OS | Ubuntu 24.04.5 LTS, GNOME 46 on Wayland |
| Build | `npm run tauri build -- --no-bundle` (release) |
| Isolation | **Hidden screen:** an `Xvfb` display, 1920 × 1080, with no window manager. **Private message bus:** a separate D-Bus daemon. **Throwaway data:** a scratch `HOME`. The owner's DeskNotes was untouched. |
| Notes | Each note has a title and three short lines, in a 300 × 280 window. All are visible, laid out on a grid. Only note windows are open: the manager stays hidden at start-up when notes are visible. |
| Memory | PSS from `/proc/<pid>/smaps_rollup`, summed over the app process and all its descendants. Taken 60 s after start. |
| CPU | `utime + stime` ticks of the same processes over the next 60 s, with no input |

## Results

| Visible notes | Processes | App process | WebKit web process | WebKit network process | **Total PSS** | **Idle CPU (60 s)** |
|---|---|---|---|---|---|---|
| 1 | 3 | 80.1 MiB | 136.8 MiB | 15.4 MiB | **232 MiB** | **0.17 %** of one core |
| 10 | 3 | 83.7 MiB | 287.3 MiB | 15.5 MiB | **387 MiB** | **0.58 %** |
| 30 | 3 | 92.7 MiB | 641.6 MiB | 15.5 MiB | **750 MiB** | **1.43 %** |

- **Each extra note costs about 18 MiB** ((750 − 387) / 20). Almost all of it is in the one shared WebKit web process, as ADR-0006 intended.
- **The process count stays at 3** whatever the number of notes.
- **Idle CPU stays under 1.5 % of one core** even with 30 notes, and nothing ticks in the background beyond the reminder and automation timers.
- **No regression since M1:**

  | Notes | M1 (shared process, 2026-11-01) | This build |
  |---|---|---|
  | 10 | 446 MiB | 387 MiB |
  | ~30 | 737 MiB (28 notes) | 750 MiB (30 notes) |

  The M1 runs also had the manager open.

## Saving a note

`Database::save_content` is the work behind every autosave: validation, title and search text, the image references, all in one transaction. It was timed on a real file database in a temp folder, with a release build, 200 saves per size, and one character changed each time.

| Note | Size | Median | p95 | Max |
|---|---|---|---|---|
| Typical (5 lines) | 0.9 KB | 0.05 ms | 0.07 ms | 0.9 ms |
| Long (200 lines) | 58 KB | 0.80 ms | 1.13 ms | 23 ms |
| Near the limit | 962 KB (limit 1 MiB) | 10.7 ms | 17.4 ms | 30 ms |

The benchmark ran while the memory runs above were also using the machine, so the maximum times are likely inflated. Even near the size limit, a save is far below the 500 ms autosave debounce.

## Not measured

| Item | Why |
|---|---|
| **Cold start to the first note visible** | On the hidden screen with a private bus, GTK waits about 25 s for desktop services that are missing there, so the time would be meaningless. Measuring it needs the real desktop session. **Owner check, optional:** quit DeskNotes, start it from the app grid, and note roughly when the notes appear. |
| **Memory on the real desktop** (GPU compositing under GNOME/XWayland) | Xvfb renders in software, so the real session may differ a little. The ratios between 1, 10 and 30 notes are what matter for comparing releases. |
| **Notes with images** | Images add their decoded pixels to the web process while they are shown. That was not part of this baseline. |
