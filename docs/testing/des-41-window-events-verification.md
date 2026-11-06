# DES-41 — events sent to one window: verification on Ubuntu

Date: 2026-11-06 · Branch: `fix/window-scoped-events` · Jira: DES-41

## The bug

When a note's window is open, Rust hands a manager action to that window with
`app.emit_to(label, "note-action", action)`. The webview listened with a plain `listen()`, which
registers with target `Any`. Tauri 2.12.5 delivers an `emit_to` event to every `Any` listener in
every webview (`event/listener.rs`, `match_any_or_filter`). So every open note ran the action on
its own note.

The fix makes the listeners for events Rust sends to one window (`note-action`,
`privacy-changed`, `settings-section`, `note-resized`, `note-settings-note`) listen in the
current webview window only. Events sent to every window with `app.emit` still reach them:
`emit` passes no filter, so every listener matches.

## Machine and conditions

| Item | Value |
|---|---|
| OS | Ubuntu 24.04.5 LTS, GNOME 46 on Wayland |
| Build | Debug binary (`cargo build -p desknotes`) with the UI served by `npm run dev` |
| Isolation | **Hidden screen:** an `Xvfb` display, 1920 × 1080, with no window manager. **Private message bus:** a separate D-Bus daemon. **Throwaway data:** a scratch `HOME`, so the data folder was throwaway. The owner's notes were never opened. |
| Method | Clicks and keys with libxdo, screenshots with `import`, the database read with Python `sqlite3` in read-only mode. The manager was opened by launching the binary a second time, since there is no tray on the private bus. |

## Before the fix (`main` at c420cfc)

| # | Check | Result |
|---|---|---|
| B1 | Two notes open (Welcome and a new note A). In the manager, hover A's row and click **Move to trash** | **Both** notes went to the Trash, with the same `deleted_at` (1793981128941). Both windows closed. The manager showed "Trash 2" and an empty Active list. |

## After the fix

| # | Check | Result |
|---|---|---|
| F1 | Same steps as B1 on fresh data | Only A went to the Trash. Welcome kept `deleted_at` NULL and stayed visible, with its window open. |
| F2 | New note C, then **Archive** on C's row | Only C was archived. Welcome stayed open. |
| F3 | New note D, then the eye button (hide) on D's row | Only D was hidden. Welcome stayed open. Final tabs: Active 2, Archived 1, Trash 1. |
| F4 | Set a PIN in Settings → Privacy, make Welcome private, **Lock now** | The Welcome note showed its PIN pad and the manager showed "Private note". |
| F5 | Restart, then unlock from the note's PIN pad. A temporary probe (not committed) added a red banner whenever the window-scoped `privacy-changed` listener fired | Both the manager and the Welcome note showed one banner each with `{"locked":false}`. So the broadcast still reaches window-scoped listeners. |

## Not checked in the real app

| Item | Why |
|---|---|
| `complete` and `reopen` sent from another window | No manager control sends them while the note is open. They use the same listener as F1–F3. |
| `privacy-changed` sent to one kept-open note (`release_kept_open`) | It needs a private note whose text could not be saved at the moment of locking. It uses the same `emit_to` targeting that F1 shows working. Its reach is now narrower, as intended: before the fix, every other window received it too. Other kept-open private notes then ran `checkLock`, which saved them and locked them early. Now each one locks on its own next save (design §4.3), and the manager still refreshes from `notes-changed`. |
| `settings-section`, `note-resized`, `note-settings-note` | Each goes to a window that exists only once, so nothing else listened for them. They are scoped too, so a future listener elsewhere cannot catch them. |

## Automated tests

`src/ipc/events.test.ts` asserts that each of the five listeners registers with
`{ target: { kind: "WebviewWindow", label } }`. Before the fix those tests failed. A further
test checks that subscribing outside Tauri rejects instead of throwing, which the Settings and
Note settings windows rely on. `npm test` (675), `npm run lint` and `npm run typecheck` pass.
No Rust code changed.

The real-app checks ran before the review made the helper `async`. That change only turns a
synchronous throw into a rejection. Inside the app the same `listen()` call is made with the same
target.
