# Milestone 5 — welcome note and About page: verification on Ubuntu

Date: 2026-11-05 · Branch: `feat/welcome-about` (verified at 1f5ac6c; later commits changed only: 7ef9613 the copy-state edge cases, their tests, a logging guard in `place_welcome_note` in `src-tauri/src/windows/mod.rs` and the removal of a 2 px radius in `settings.css`; the final fix wave the About accessibility attributes (link hints as descriptions, a live region for Copied), the `/usr/lib/os-release` fallback and last-`PRETTY_NAME`-wins rule for the OS name, a CSS comment, and this note) · Jira: DES-29
Design: `docs/superpowers/specs/2026-11-05-welcome-and-about-design.md`

## Machine and conditions

| Item | Value |
|---|---|
| OS | Ubuntu 24.04.5 LTS, GNOME 46 on Wayland |
| Build | Release binary of this branch (`npm run tauri build -- --no-bundle`) |
| Isolation | Hidden X display (`Xvfb`, 1920 × 1080, no window manager), a private D-Bus daemon, and a scratch `HOME`, so `~/.local/share/io.github.krusselalex.desknotes/` was a throwaway folder. The owner's DeskNotes kept running untouched, and nothing appeared on their screen. |
| Links | The scratch `HOME` had a `mimeapps.list` that sends `http`/`https` to a small script recording each URL, so no real browser was opened. |
| Method | Clicks with libxdo, window screenshots with `import`, window geometry with `xwininfo`, and the database read with Python `sqlite3` in read-only mode |

## Checked in the real app

| # | Check | Result |
|---|---|---|
| W1 | First launch on an empty data folder | Exactly one note, "Welcome 👋", lemon (`#fff4a3`), 300 × 280 at **810, 400**, which is centred on 1920 × 1080. The text reads exactly as specified, with "Welcome 👋" and "on this computer only" in bold. `first_run_done` = 1. The manager stayed hidden, as at any start with notes. |
| — | The welcome text is true | On hover the note's top bar shows the palette (Colour) button the text points to |
| — | Settings → About (reached through ⋯ → Open manager → ⋯ → Settings… → About) | Matches the approved mockup: app icon, DeskNotes, version 0.2.0, **Copy**, MIT license, purpose, credit, three links each marked "opens browser", the data folder with Open folder, the privacy line, and the footer links |
| — | The five links | Each click handed the system exactly one URL: `…/desknotes`, `…/desknotes/issues`, `https://github.com/KRusselAlex`, `…/blob/v0.2.0/THIRD_PARTY_NOTICES.md`, `…/blob/v0.2.0/LICENSE` |
| — | Copy | The button changes to **Copied** |
| W2 | Restart | Still exactly one note |
| W3 | Delete the welcome note permanently, then restart | No note is created. The manager opens, as with any empty install. `first_run_done` stays 1. |
| W4 | An existing 0.2.0 database with every note deleted | Upgraded to schema 7 with its pre-migration copy. **No** welcome note, and `first_run_done` is not set. |

## Not checked in the real app

| Item | Why |
|---|---|
| What Copy puts on the clipboard (`DeskNotes 0.2.0 · Ubuntu 24.04.5 LTS`) | Clipboard content can't be read back on a bare hidden display: even a plain GTK program's clipboard couldn't be read there. Unit tests cover the exact text. **Owner check** with the .deb. |
| Centring on native Wayland | DeskNotes runs through XWayland (ADR-0002). Where the window manager does not allow positioning, the note falls back to the normal new-note cascade (by design). |
| The real browser opening | It deliberately wasn't opened. The URL handed to the system was checked instead. |

## Automated tests

`npm test` (667), `npm run lint`, `npm run typecheck`, `cargo test --workspace`, `cargo clippy -D warnings` and `cargo fmt --check` pass.
- The core welcome tests prove each guard (new file, any note in any state, the `first_run_done` flag) and the rollback by mutation.
- The shell's link, centring and OS-name tests caught 16 out of 16 deliberate mutations in review.
