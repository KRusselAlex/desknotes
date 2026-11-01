---
name: desknotes-verify-ubuntu
description: Use when a DeskNotes change must be checked in the real desktop app on Ubuntu — window creation, move/resize persistence, restart restoration, single instance, memory/CPU — before marking a task done.
---

# Verify DeskNotes in the real app (Ubuntu, GNOME, XWayland)

Tools in `scripts/verify/` drive the app with simulated input through libxdo
(installed with the Tauri build packages). They use isolated data in `.verify-data/`,
never the owner's real notes. Tell the owner first: their mouse will move by itself.

## Steps
1. Build: `cargo build -p desknotes` (debug) and run `npm run dev` in the background
   (debug builds load the UI from http://localhost:1420).
2. Start: `scripts/verify/app.sh start` — prints `windowid x y width height` per window.
3. Act:
   - `python3 -I scripts/verify/x.py click X Y` (absolute screen coordinates; window
     origin + offset from the design, e.g. manager "New note" ≈ +72,+32)
   - `x.py key ctrl+n`, `x.py type "text"` (QWERTY keymap: capitals may be wrong on AZERTY)
   - `x.py size WID W H` to resize; `x.py wmmove WID X Y` to move (synthetic header
     drags do not work: the compositor performs real drags)
   - `x.py shot WID file.png`, then read the PNG to check the visuals
4. Check data: `python3 -I scripts/verify/db.py .verify-data/io.github.krusselalex.desknotes/desknotes.db`
5. Restart: quit through the manager menu (or `app.sh stop`), `app.sh start`, and compare
   window geometry and the database with step 3.
6. Resources: `scripts/verify/resources.sh` (PSS per process + idle CPU). Measure release
   builds (`npm run build && cargo build --release -p desknotes`, pass the binary path).
7. Write results, machine and conditions to `docs/testing/`. Ask the owner to confirm
   anything that needs a real person (dragging by the header, feel, readability).
