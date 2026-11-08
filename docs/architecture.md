# DeskNotes architecture and features

How DeskNotes is built today, and what every feature does. This guide describes the code
on `main` as of 2026-11-07 (commit a946766: version 0.2.0, schema version 8, backup
format 6).

- The original Milestone 0 design, with the requirements and milestone plan, is
  [design.md](design.md). Its architecture and data model stop at migration 1.
- The reasons behind the big decisions are in the ADRs in [adr/](adr/).
- Each later feature has a design in [superpowers/specs/](superpowers/specs/), a plan in
  [superpowers/plans/](superpowers/plans/), and a real-app check in [testing/](testing/).

When the code changes, update this guide in the same pull request.

---

## 1. Repository map

### `crates/desknotes-core`: the pure Rust core

It builds and tests without a desktop session. It contains all of the app's SQL. Paths in
this table are relative to `crates/desknotes-core/`.

| Module | What it owns |
|---|---|
| `src/lib.rs` | Public API: re-exports `Database`, the models and `now_ms()`. |
| `src/model.rs` | Data types (`Note`, `NoteWindow`, `Appearance`, `AppAppearance`, `NoteSize`, …) and constants: default colour `#fff4a3`, default size 300 × 280, floor 180 × 120, collapsed height 32 px. |
| `src/validation.rs` | Everything that crosses IPC: the Tiptap node and mark allowlist, link schemes, content limits, note ids, colours, per-note appearance. It also derives the title, search text and snippet from content. |
| `src/geometry.rs` | Pure window-placement rules, such as `keep_on_screen`, in logical pixels. |
| `src/backup.rs` | The portable backup file format: parse, validate and serialise. |
| `src/image_prep.rs` | Pure image preparation: detect PNG, JPEG, GIF or WebP from the bytes, decode, scale, and re-encode without metadata. No SQL, no files. |
| `src/privacy.rs` | Pure privacy-lock rules: the 6-digit PIN policy, Argon2id hashing, recovery codes and the wrong-PIN throttle. It uses no database and no clock. |
| `src/reminders.rs` | Pure reminder time rules: wall-clock date and time, repeats, time zones, DST and snooze. Callers pass the clock. |
| `src/error.rs` | `CoreError` and `CoreResult`. |
| `src/db/mod.rs` | `Database::open`: refuses newer schemas, sets WAL, makes a pre-migration copy, migrates. It also enforces the privacy lock on every read and write. |
| `src/db/migrations.rs` | Append-only schema migrations, tracked with `PRAGMA user_version`. |
| `src/db/notes.rs` | The note repository: create, save, list and search, colour, appearance, archive, done, trash, restore, purge, and window state. |
| `src/db/settings.rs` | The key–value settings table and its typed accessors. |
| `src/db/privacy.rs` | Storage for the PIN hash, recovery-code hash, throttle, reset marker, lock-after setting and recovery method. |
| `src/db/reminders.rs` | Reminder storage, due and catch-up queries, and the Reminders list. |
| `src/db/backup.rs` | Whole-collection export and restore. |
| `src/db/welcome.rs` | The welcome note that a brand-new database gets once. |
| `src/db/images.rs` | Image blobs keyed by SHA-256, which notes use which image, serving rules under the lock, and start-up clean-up. |
| `src/db/automation.rs` | The automation rules' settings and the data changes they make (archive done notes, empty old trash, untick a checklist). |
| `tests/` | Integration tests: privacy API and lock, and upgrades from released databases (`fixtures/release-0.2.0.*`). |

### `src-tauri/src`: the desktop shell (Tauri 2)

A thin adapter around the core: commands, windows, platform code.

| Path | What it owns |
|---|---|
| `main.rs` | Picks the display backend before GTK starts, then calls `run()`. |
| `lib.rs` | Plugins, start-up order, the `generate_handler!` command list, and the final geometry flush on exit. |
| `state.rs` | `AppState`: the `Database` behind a mutex, start-up errors, geometry writer, save-all coordinator, pending restore and activity time. The database file is `desknotes.db` in the app data folder, with safety copies in `backups/`. |
| `error.rs` | `IpcError { code, message }`, the error shape every command returns. |
| `commands/` | `#[tauri::command]` entry points, by area: `notes`, `note_settings`, `app`, `settings`, `backup`, `privacy`, `reminders`, `images`. Each validates its input and delegates to the core. |
| `windows/mod.rs` | Creates, shows, hides, places and closes every window. It also holds the event names and emitters, and the start-up restore. |
| `windows/note_settings.rs` | The Note settings window and where it is placed. |
| `windows/image_drop.rs` | Reads files dropped on a note window in Rust and stores the images. |
| `windows/geometry.rs` | Debounced writer for window position and size: one thread, saves after 400 ms of stillness. |
| `quit.rs` | The save-all handshake used before quit, export, restore, Hide all and lock. |
| `privacy.rs` | Decides when the lock changes: save, then lock or unlock, then tell the windows. |
| `reminders.rs` | The reminder scheduler thread and the notification button actions. |
| `automation.rs` | When automation rules 3 and 4 run (start-up, hourly, after a change or an unlock), and rule 2 when a repeating reminder fires. |
| `reset_pin.rs` | `desknotes --reset-pin`, run in a terminal before Tauri starts. |
| `tray.rs` | The tray icon and its menu. |
| `platform/` | Operating-system code, all of it Linux-only today (see below). |

| `platform/` file | What it owns |
|---|---|
| `mod.rs` | XWayland selection (`select_display_backend`), `window_positioning_supported`, the OS name for About, and the user data folder. |
| `notify.rs` | Desktop notifications through `org.freedesktop.Notifications` over zbus. |
| `lock_triggers.rs` | D-Bus watchers for sleep and screen lock, and the inactivity timer. |
| `system_auth.rs` | Proof of the Ubuntu password through polkit (`pkcheck`), for a forgotten PIN. |
| `single_instance.rs` | Holds DeskNotes' single-instance name for `--reset-pin`, which refuses while DeskNotes runs. |
| `gnome_shortcut.rs` | Adds DeskNotes' GNOME custom keyboard shortcut through GSettings. |
| `fonts.rs` | Lists installed font families (`fc-list`). |
| `clipboard.rs` | Reads a pasted image from the system clipboard, since WebKitGTK gives the page none. |

Other shell files:

- `capabilities/default.json`: permissions for `manager`, `settings` and `note-*`. Only
  core window permissions, plus the opener limited to `http`, `https` and `mailto` links.
- `capabilities/note-settings.json`: permissions for `note_settings`.
- `polkit/`: the polkit policy used for the system-password check.
- `tauri.conf.json`: bundle id `io.github.krusselalex.desknotes`, version, the
  `deb` and `appimage` targets, and the CSP. Its only non-`self` image source is the
  local `desknotes-image:` scheme.

### `src`: the webview (React and TypeScript)

| Path | What it owns |
|---|---|
| `main.tsx`, `app/App.tsx` | One bundle serves every window. The window **label** decides the screen: `manager`, `settings`, `note_settings`, or `note-<id>`. |
| `app/` | Activity reporting for the inactivity lock (`activity.ts`), theme, time formatting, window size. |
| `ipc/commands.ts` | The **only** place that calls `invoke`; ESLint enforces this in `eslint.config.js`. Each function maps to one Rust command. |
| `ipc/events.ts` | Event names and typed `listen` helpers. |
| `ipc/images.ts` | Builds `desknotes-image` addresses for stored images, and reads the id back from one. |
| `ipc/window.ts` | Thin wrappers over the Tauri window and opener APIs, such as `onCloseRequested` and `noteIdFromUrl`. |
| `features/notes/` | The note window: editor, extensions, autosave, format bar, Aa popover, colour and reminder popovers, links, images (`imageNode.ts`, `imageInput.ts`), checklist helpers for the automation rules, the "Marked done" strip. |
| `features/manager/` | The manager window: tabs, search, rows, the Reminders list. |
| `features/settings/` | The Settings window: panes for General, Appearance, Automations, Privacy, Backup and About, PIN setup, shortcut row. |
| `features/note-settings/` | The per-note settings window. |
| `features/privacy/` | PIN pad, unlock dialog, private label dialog, forgotten PIN. |
| `features/appearance/` | The colour presets and contrast helpers, plus the app-wide appearance hook. |
| `components/` | Shared `Icon`, `Menu`, `Segmented` and `Switch`. The icon set is `icons.ts`. |
| `styles/` | `tokens.css` holds the design tokens; the other files hold per-window styles. |
| `types/` | TypeScript mirrors of the Rust payloads (`note.ts`, `reminder.ts`). |
| `dev/preview.tsx` | Development-only browser preview with Tauri IPC mocks and an in-memory fake database (`preview.html?w=manager`, `?w=note&id=…`). It is not part of the app build. |
| `test/setup.ts` | Vitest setup. |

`tests/fixtures/` (at the repository root) holds rich-text fixtures shared by the Rust and
TypeScript validation tests.

### `scripts/` and `docs/`

| Path | What it is |
|---|---|
| `scripts/setup-ubuntu.sh` | Installs the Ubuntu build packages. |
| `scripts/verify/` | Real-app checks with isolated test data. `app.sh` starts and stops the app, `x.py` drives X11 windows (click, type, move, screenshot), `tray.py` lists and clicks tray items, `db.py` reads the database read-only, `resources.sh` measures memory and idle CPU. |
| `scripts/release/` | Release safety: `check-tag.sh`, `changelog-section.sh`, `make-fixture.sh` (upgrade fixture of a released version), and their tests in `test.sh`. |
| `docs/design.md` | The original Milestone 0 design. |
| `docs/adr/` | Architecture decisions 0001–0006. |
| `docs/superpowers/specs/`, `plans/` | One design and one implementation plan per feature. |
| `docs/testing/` | Real-app verification records. |
| `docs/backup-format.md`, `upgrading.md`, `releasing.md`, `ui-design-brief.md` | The backup file format, upgrade and rollback for users, the release checklist, and the UI brief. |

---

## 2. Architecture and rules

```
 webview (React, one bundle per window)       src/
   features/*  ──calls──▶  src/ipc/commands.ts ──invoke──┐
   features/*  ◀─listen──  src/ipc/events.ts   ◀─emit────┤
                                                        │ Tauri IPC
 shell (Tauri 2)                                        ▼   src-tauri/src/
   commands/*  →  windows/, privacy.rs, reminders.rs, tray.rs, platform/*
        │
        ▼
 core (pure Rust, no GUI)                                   crates/desknotes-core/
   validation · model · geometry · privacy · reminders · backup · db/* (all SQL)
        │
        ▼
 SQLite file  ~/.local/share/io.github.krusselalex.desknotes/desknotes.db (+ backups/)
```

These rules hold everywhere:

1. **All SQL lives in the core** (`crates/desknotes-core/src/db/`). The shell holds
   platform code and orchestration only.
   ADR: [0001](adr/0001-modular-monolith-with-pure-rust-core.md).
2. **The webview talks to native code only through named commands and events.**
   `src/ipc/commands.ts` is the only caller of `invoke`, and there is no SQL plugin.
   Rust validates every argument; the webview is treated as untrusted.
   ADR: [0003](adr/0003-sqlite-behind-native-commands.md).
3. **Note content is validated Tiptap JSON, never HTML.**
   - `validation.rs` checks every document against `ALLOWED_NODES` and `ALLOWED_MARKS`.
   - Links may only be `http:`, `https:` or `mailto:`.
   - A note is at most 1 MiB and 64 levels deep.
   - New nodes or marks must be added to that allowlist and to the shared fixture.

   ADR: [0004](adr/0004-rich-text-as-validated-json.md).
4. **No network.**
   - The app makes no requests and has no update check, telemetry or account.
   - Images are served to the editor only through the local `desknotes-image` scheme.
     The CSP allows no `http` or `https` images.
   - The only way out is the opener plugin. It opens a link in the system browser when
     the person clicks one. In a note this needs Ctrl+click. In About, the fixed links
     are named by id, never by URL (`open_external_link`).
5. **The core enforces the privacy lock.** A locked private note's text is withheld from
   every read, and changes to it are refused, whatever a caller sends (`db/mod.rs`).
6. **Window titles, notifications and previews never show note text.** Every note window
   is titled "DeskNotes".
   - Exception (DES-36): a reminder notification shows the note's **title**, or
     "Private note" while the note is locked.
7. **Data safety.** Migrations are append-only and never drop data. A copy of the
   database is written before any migration and before any restore (§4.4).

Other ADRs: [0002 XWayland](adr/0002-xwayland-on-linux-wayland.md),
[0005 MIT licence](adr/0005-mit-license.md),
[0006 shared web process](adr/0006-shared-web-process-on-linux.md).

---

## 3. Windows and processes

### Process model

- **One process, one instance.** `tauri-plugin-single-instance` is registered first in
  `src-tauri/src/lib.rs`. A second launch hands its arguments over to the running app and
  exits. With `--toggle-notes` it hides or shows the notes; otherwise it shows the manager.
- **XWayland by default.** On a Wayland session, `platform::select_display_backend()`
  sets `GDK_BACKEND=x11` before GTK starts (`main.rs`). Native Wayland would not let the
  app place windows or keep them on top. `DESKNOTES_BACKEND=wayland` opts out, and
  `window_positioning_supported()` then turns position save and restore off.
  ADR: [0002](adr/0002-xwayland-on-linux-wayland.md).
- **One shared WebKit web process.** Every window after the manager is built with
  `with_related_view(manager's webview)` (`build_sharing_process` in `windows/mod.rs`).
  It joins the manager's web process instead of starting its own: about 20 MiB per note
  instead of about 80 MiB. So the **manager must exist before any other window, and is
  never destroyed.** ADR: [0006](adr/0006-shared-web-process-on-linux.md).
- **Threads in the shell:**
  - the geometry writer;
  - the reminder scheduler;
  - the automation rules (hourly);
  - D-Bus lock watchers and the inactivity ticker;
  - one notification listener;
  - short-lived threads for actions that wait on note windows (save-all).

### Start-up order (`lib.rs` `setup`, `windows::restore_on_startup`)

1. `desknotes --reset-pin` is handled first. It runs in the terminal and exits without
   starting Tauri.
2. `AppState::open` opens the database (migrating it if needed) and removes images no
   note uses, which happens only at start-up. The privacy lock starts **on** whenever a
   PIN is set, before any window can ask for text.
3. On a brand-new database the welcome note is created and centred on the primary screen.
4. The **manager** is created. It is shown only when:
   - no note will open;
   - there are start-up errors; or
   - "The PIN was reset" is waiting to be seen.

   Otherwise it is created hidden.
5. Each visible note's window opens.
6. The tray icon is installed. Automation rules 3 and 4 run once, then hourly on their
   own thread. The reminder scheduler starts, then the lock triggers start.

### The four kinds of window

All are created only in Rust (`windows/`), never from the webview.

| Label | What | Size and place | Created and closed |
|---|---|---|---|
| `manager` | Note lists, search, Reminders | 560 × 620 (min 400 × 360), centred | Created at start-up, hidden or shown. Closing it **hides** it while any note is open; with no notes open, closing it quits the app. |
| `note-<id>` | One note | The saved size, at least the "Minimum note size". The saved position goes through `keep_on_screen`. A new note cascades from the top-left of the primary work area (64 px, plus 28 px per open note, 8 steps). | Undecorated and not maximisable. Created **hidden, then shown**, so Mutter does not add 37 px to its height. `transparent` only when opacity is below 100 %, so crossing 100 % reopens the window (`reopen_note`). Collapsed notes are pinned to a 32 px strip. `close_note` saves the geometry and destroys the window. |
| `settings` | App settings | 680 × 520 (min 560 × 420), centred | One at a time. `?section=` picks the pane (`general`, `appearance`, `automations`, `privacy`, `privacy-new-pin`, `backup`, `about`). An open window is focused and sent `settings-section`. |
| `note_settings` | Settings for one note | 400 wide. Height is min(640, work area − 48), min 360 × 400. | One at a time. Placed beside the note: 12 px to its right, else to its left, else centred (`place_beside`). `?note=<id>` gives the note. Switching notes sends `note-settings-note`. The label uses an underscore on purpose, so it never matches `note-`. |

**Geometry.**
- Move and resize events of note windows go to the debounced writer
  (`windows/geometry.rs`, 400 ms).
- Minimised and maximised states are ignored.
- The writer is flushed on window close and on app exit.
- With several monitors, the work area that overlaps a note most is used (`best_area`).
  A note off every screen falls back to the primary one.

**Files dropped on a note.** Tauri's own drag-and-drop handler stays on, because
WebKitGTK gives the page no dropped files. `on_window_event` hands a drop on a note window
to `windows/image_drop.rs`, which reads and stores the files in Rust.

**After a note hides.** If no note window and no visible manager remain, the manager is
shown, so DeskNotes always stays reachable (`after_note_hidden`).

---

## 4. Data model

### Tables (schema version 8, `crates/desknotes-core/src/db/migrations.rs`)

All times are Unix milliseconds in UTC. Booleans are `INTEGER` 0 or 1.

**`notes`**

| Column | Type | Notes |
|---|---|---|
| `id` | TEXT PK | UUID |
| `title` | TEXT | Derived from the content (at most 80 characters); never sent by the webview |
| `content_json` | TEXT | Validated Tiptap JSON |
| `search_text` | TEXT | Lower-cased plain text, used for search |
| `color` | TEXT | `#rrggbb` |
| `created_at`, `updated_at` | INTEGER | |
| `archived_at`, `deleted_at` | INTEGER NULL | Archived; in the trash |
| `edit_locked` | INTEGER | Read-only note (v2) |
| `private`, `private_label` | INTEGER, TEXT | Private flag, and the neutral label shown while locked (v4) |
| `appearance` | TEXT | JSON: font, size, text colour, line spacing, direction, opacity. `'{}'` means defaults (v5) |
| `completed_at` | INTEGER NULL | When the note was marked done (v7) |

**`note_windows`** (one row per note, `ON DELETE CASCADE`)

| Column | Type | Notes |
|---|---|---|
| `note_id` | TEXT PK, FK | |
| `x`, `y` | REAL NULL | Logical pixels. NULL means not placed yet. |
| `width`, `height` | REAL | While collapsed, `height` keeps the expanded height |
| `visible` | INTEGER | Window open |
| `always_on_top` | INTEGER | |
| `collapsed` | INTEGER | Rolled up to the header strip (v3) |

**`reminders`** (at most one per note, `ON DELETE CASCADE`, v6)

| Column | Type | Notes |
|---|---|---|
| `note_id` | TEXT PK, FK | |
| `local_date`, `local_time` | TEXT | The wall-clock date and time the person picked (`YYYY-MM-DD`, `HH:MM`) |
| `repeat` | TEXT | `none`, `daily`, `weekdays`, `weekly` or `monthly` |
| `due_at` | INTEGER | The next occurrence, in UTC |
| `snoozed_until`, `fired_at` | INTEGER NULL | |

**`images`** (v8)

| Column | Type | Notes |
|---|---|---|
| `id` | TEXT PK | Lower-case hex SHA-256 of `bytes`, so the same image is stored once |
| `mime` | TEXT | `image/png`, `image/jpeg`, `image/gif` or `image/webp` |
| `width`, `height` | INTEGER | Pixels, after preparation |
| `bytes` | BLOB | The re-encoded image (at most 5 MB) |
| `created_at` | INTEGER | |

**`note_images`** (v8): `note_id` (FK to `notes`, `ON DELETE CASCADE`), `image_id` (FK to
`images`), primary key `(note_id, image_id)`, index on `image_id`. It is rewritten from a
note's content each time the note is saved. Images that no note uses are deleted only at
start-up, so Undo after removing an image always works.

**`settings`**: `key TEXT PK`, `value TEXT`.

**Migration history**

| v | Change |
|---|---|
| 1 | `notes`, `note_windows`, `settings` |
| 2 | `notes.edit_locked` |
| 3 | `note_windows.collapsed` |
| 4 | `notes.private`, `notes.private_label` |
| 5 | `notes.appearance` |
| 6 | `reminders` table |
| 7 | `notes.completed_at` |
| 8 | `images` and `note_images` tables |

### Settings keys

| Key | Value | Defined in |
|---|---|---|
| `new_note_color` | `#rrggbb` for new notes | `db/settings.rs` |
| `hidden_by_hide_all` | JSON list of the note ids that "Hide all notes" hid | `db/settings.rs` |
| `min_note_size` | JSON `{width, height}`. Each side runs from the floor (180 × 120) to 600 | `db/settings.rs` |
| `appearance_high_contrast` | `"true"` or `"false"` | `db/settings.rs` |
| `appearance_layout` | `"comfortable"` or `"compact"` | `db/settings.rs` |
| `appearance_default_font` | A font name, or empty for the system default | `db/settings.rs` |
| `appearance_default_size` | `"10"`–`"32"` px (default 15) | `db/settings.rs` |
| `first_run_done` | `"1"` once the welcome note was created | `db/settings.rs` |
| `auto_complete_checklists` | `"1"` or absent: automation rule 1 | `db/settings.rs` |
| `reset_checklists_on_repeat` | `"1"` or absent: rule 2 | `db/settings.rs` |
| `archive_done_enabled`, `archive_done_days` | `"1"` or absent; days 1–90 (default 7): rule 3 | `db/settings.rs` |
| `purge_trash_enabled`, `purge_trash_days` | `"1"` or absent; days 7–365 (default 30): rule 4 | `db/settings.rs` |
| `purge_trash_off_by_restore` | `"1"` when a backup restore switched rule 4 off | `db/settings.rs` |
| `last_backup_at` | Time of the last successful export | `db/backup.rs` |
| `pin_hash` | Argon2id hash of the PIN | `db/privacy.rs` |
| `pin_recovery_hash` | Hash of the recovery code | `db/privacy.rs` |
| `pin_throttle` | JSON `{failures, wait_until_ms}`, shared by PIN and code checks | `db/privacy.rs` |
| `pin_reset_at` | Time of the last `--reset-pin`, until it is acknowledged | `db/privacy.rs` |
| `lock_after_minutes` | 1, 5, 10 or 15 (default 5) | `db/privacy.rs` |
| `recovery_method` | `"system"` or `"code"` | `db/privacy.rs` |

Reading a bad stored value never fails: each typed accessor falls back to its default.
Each rule's days are kept while the rule is off, so turning it back on restores them.
"Launch at login" is not stored here. It is the presence of the autostart entry (§6.15).

### Opening the database and safety copies (`db/mod.rs`, `db/backup.rs`)

- **Newer schema.** A database whose `user_version` is newer than the app knows is
  refused (`SchemaTooNew`) **before anything is written**, not even the switch to WAL.
  The user sees "Your notes were saved by a newer version" ([upgrading.md](upgrading.md)).
- **Pre-migration copy.** Before migrating an existing database, a consistent copy is
  written to `backups/pre-migration-v<old>-<ms>.db`. Each migration then runs in its own
  transaction.
- **Pre-restore copy.** Before a restore, a copy is written to
  `backups/pre-restore-<ms>.db`. The replacement is then one transaction.
- **Connection settings:** `journal_mode=WAL`, `synchronous=NORMAL`, `foreign_keys=ON`,
  a busy timeout of 5 s.

### Backup format

A backup is one JSON file, format `desknotes-backup`, **version 6**. It holds every note
(active, archived, trash) with its window state, appearance, private flag, reminder and
done date. A top-level `images` list carries the pictures the notes use, as base64. The
file may be at most 300 MiB. It holds **no** settings, PIN or recovery code. Formats 1–5
still restore. Full specification: [backup-format.md](backup-format.md). Code:
`crates/desknotes-core/src/backup.rs` and `db/backup.rs`.

---

## 5. IPC reference

The webview calls commands through `src/ipc/commands.ts`, which uses the same names in
camelCase. Errors arrive as `CommandError { code, message }`. There are 70 commands,
registered in `src-tauri/src/lib.rs`.

### Commands

**Notes** (`commands/notes.rs`)

| Command | What it does | Called by |
|---|---|---|
| `list_notes` | Notes in one list (`active`, `completed`, `archived`, `trash`), filtered by a search query | Manager |
| `note_counts` | How many notes each tab holds | Manager |
| `get_note` | One note; a locked private note comes without its text | Note window, Note settings |
| `create_note` | Creates a note in the preferred colour and opens it | Note window, Manager (Ctrl+N, New note); the tray calls the same Rust code |
| `save_note_content` | Validates and saves the editor document, and derives the title and search text | Note window (autosave) |
| `set_note_color` | Sets the background colour | Note window, Note settings |
| `duplicate_note` | Copies a note and opens the copy | Note window |
| `set_archived` | Archives (hides the window) or unarchives | Manager, Note window |
| `set_note_completed` | Marks done (closes the window) or reopens | Manager, Note window |
| `trash_note` | Moves to the trash (hides the window) | Manager, Note window |
| `restore_note` | Brings a note back from the trash | Manager |
| `purge_note` | Deletes for good; only works on a note already in the trash | Manager |
| `show_note` | Opens or focuses a note's window. Refused for archived, trashed or done notes | Manager; Rust on a notification click |
| `hide_note` | Closes the window; the note stays active | Manager, Note window |
| `set_edit_locked` | Makes the note read-only; the core refuses saves while it is | Note window, Note settings |
| `set_always_on_top` | Keeps the note above other windows | Note window, Note settings |
| `set_collapsed` | Rolls the note up to its header strip, or expands it | Note window |
| `hide_all_notes` | Saves all notes, hides them, and remembers which | Manager menu; tray and shortcut (Rust) |
| `show_hidden_notes` | Shows those notes again | Manager menu; tray and shortcut (Rust) |
| `hidden_note_count` | How many notes "Show hidden notes" would bring back | Manager |
| `claim_checklist_reset` | Takes this note's pending checklist reset (automation rule 2). True means untick now, once per reset | Note window (on load and on `checklist-reset`) |

**Note settings** (`commands/note_settings.rs`)

| Command | What it does | Called by |
|---|---|---|
| `set_note_appearance` | Saves the font, size, text colour, line spacing, direction and opacity | Note settings |
| `set_note_size` | Resizes the note, kept within the minimum size and the screen; returns the size applied | Note settings |
| `list_fonts` | Installed font families, A to Z | Aa popover, Note settings, Appearance pane |
| `open_note_settings` | Opens the Note settings window, or switches it to this note | Note window |
| `reopen_note` | Closes and reopens the caller's own note window, needed when opacity crosses 100 % | Note window |

**App** (`commands/app.rs`)

| Command | What it does | Called by |
|---|---|---|
| `show_manager` | Shows the manager | Note window |
| `startup_errors` | Problems found at start-up | Manager |
| `quit_app` | Saves all notes, then quits. Cancels with `quit-blocked` if any note holds unsaved text | Manager; tray (Rust) |
| `quit_ready` | A note window's answer to `save-all-notes` | Note window |

**Settings** (`commands/settings.rs`)

| Command | What it does | Called by |
|---|---|---|
| `open_settings` | Opens or focuses Settings, optionally at a section | Manager, Note window, Forgot PIN |
| `get_settings` | Everything the Settings window shows | Settings |
| `set_launch_at_login` | Writes or removes the autostart entry; returns the state now in effect | Settings › General |
| `set_new_note_color` | The colour for new notes | Settings › General |
| `set_min_note_size` | The minimum note size, applied to open notes too | Settings › General |
| `get_app_appearance` / `set_app_appearance` | App-wide note appearance. Setting it emits `app-appearance-changed` | Every window (get), Settings › Appearance (set) |
| `get_toggle_shortcut` / `set_toggle_shortcut` / `remove_toggle_shortcut` | The GNOME "Show / hide all notes" shortcut | Settings › General (shortcut row) |
| `open_data_folder` | Shows the data folder in the file manager | Settings |
| `open_external_link` | Opens a fixed About link (`source`, `issues`, `more_tools`, `notices`, `license`) | Settings › About |
| `set_automations` | Saves the automation rules, runs rules 3 and 4 once, emits `automations-changed`. It never turns rule 4 on. Settings window only | Settings › Automations |
| `enable_purge_trash` | Turns "Empty old trash" on with its days (7–365), after its confirmation dialog: the only way to switch it on. Settings window only | Settings › Automations |
| `count_purgeable` | How many notes "Empty old trash" would delete now with these days, for the dialog | Settings › Automations |

**Images** (`commands/images.rs`)

| Command | What it does | Called by |
|---|---|---|
| `add_image` | Checks, prepares and stores an image for a note. The bytes travel as the raw IPC body, and the `note-id` header names the note | Note window (`imageInput.ts`) |
| `pick_image` | "Insert image…": opens the file dialog in Rust and adds the chosen image; null when cancelled | Note window (`imageInput.ts`) |
| `paste_image` | Reads the system clipboard in Rust: stores its image for the note, or gives back its text | Note window (`imageInput.ts`), on a paste the page sees as empty |

Stored images are served by the asynchronous `desknotes-image` URI scheme
(`commands::images::handle_scheme`), not by a command. Only a 64-hex id is accepted.
While the lock is on, an image used only by locked private notes gets an empty 404.

**Backup** (`commands/backup.rs`)

| Command | What it does | Called by |
|---|---|---|
| `export_backup` | Saves all notes, opens a save dialog, writes the JSON through a temporary file | Settings › Backup |
| `choose_backup` | Opens a file dialog and fully validates the file. Nothing changes yet | Settings › Backup |
| `cancel_restore` | Drops the chosen file | Settings › Backup |
| `restore_backup` | Saves all notes, writes a safety copy, replaces every note, reopens the visible ones | Settings › Backup |

**Privacy** (`commands/privacy.rs`)

| Command | What it does | Called by |
|---|---|---|
| `privacy_status` | Whether a PIN is set and the lock is on, the recovery method, a pending reset notice | Manager, Note window, Privacy pane, Forgot PIN |
| `unlock` | Checks the PIN and unlocks every private note; wrong PINs start growing waits | PIN pad (unlock dialog) |
| `lock_now` | Saves all notes, then locks | Manager, Privacy pane; the tray calls the same Rust code |
| `setup_pin` | First PIN plus the recovery method (`system` or `code`); returns a code shown once | PIN setup (Settings) |
| `change_pin` | Current PIN, then the new one | Settings |
| `turn_off_lock` | Needs the PIN; private flags and labels are kept | Privacy pane |
| `set_recovery_method` | Needs the PIN; switching to `code` returns a new code | Privacy pane |
| `set_lock_after` | Inactivity minutes: 1, 5, 10 or 15 | Privacy pane |
| `set_note_private` | Makes a note private (needs a PIN to exist) with an optional label, or not private | Note window |
| `report_activity` | Input seen, for the inactivity lock | Every window (`app/activity.ts`) |
| `acknowledge_pin_reset` | Dismisses "The PIN was reset on …" | Manager |
| `forgot_pin_system` | Ubuntu password through polkit. On success: unlock, and allow one new PIN | Forgot PIN |
| `recover_with_code` | Recovery code. On success: unlock, and allow one new PIN | Forgot PIN |
| `choose_new_pin` | Sets the new PIN after one of those proofs. Only the Settings window may call it | PIN setup (Settings) |

**Reminders** (`commands/reminders.rs`)

| Command | What it does | Called by |
|---|---|---|
| `get_reminder` | The note's reminder, or null | Note window |
| `set_reminder` | Sets or replaces the reminder (date, time, repeat). A one-off in the past is refused | Reminder popover |
| `remove_reminder` | Removes it | Reminder popover |
| `list_reminders` | Reminders on notes not in the trash, earliest first, filtered by title | Manager › Reminders |

### Events

Names live in `src/ipc/events.ts` and `src-tauri/src/windows/mod.rs` (`PRIVACY_CHANGED`
and `ACTION_FAILED` are defined in `privacy.rs` and `tray.rs`).

- **App-wide** means emitted with `app.emit`, to every window.
- **Window-scoped** means emitted with `app.emit_to(label, …)`.

| Event | Payload | Emitted by | Scope | Listened by |
|---|---|---|---|---|
| `notes-changed` | `{ id \| null, kind: "content" \| "other" }` | `windows::emit_changed`, after any note change | App-wide | Manager, Note window, Note settings |
| `save-all-notes` | none | `windows::save_all_open_notes*` (quit, export, restore, Hide all, lock) | App-wide | Note window: saves, then answers `quit_ready` |
| `quit-blocked` | count of unsaved notes | `commands/app.rs` | App-wide | Manager |
| `note-action` | `"hide" \| "archive" \| "trash" \| "complete" \| "reopen"` | `windows::delegate_to_note` (an action started outside an open note) and `set_note_appearance` (`reopen`) | Window-scoped: that note | Note window: saves, then acts |
| `action-failed` | message | `tray.rs` | App-wide | Manager |
| `privacy-changed` | `{ locked }` | `privacy.rs` | App-wide. Also window-scoped to one note window when a note kept open at the last lock now locks | Manager, Note window, Privacy pane |
| `settings-section` | section name | `windows::open_settings` | Window-scoped: `settings` | Settings |
| `note-resized` | `{ id, width, height }` | `windows::on_window_event`, while Note settings is open | Window-scoped: `note_settings` | Note settings |
| `note-settings-note` | note id | `windows/note_settings.rs` | Window-scoped: `note_settings` | Note settings |
| `app-appearance-changed` | `AppAppearance` | `windows::emit_app_appearance_changed` | App-wide | Every window (`useAppAppearance`) |
| `reminders-changed` | `{ noteId \| null }`; never a title | `windows::emit_reminders_changed` | App-wide | Manager, Note window |
| `images-dropped` | `{ noteId, images, texts, problem, x, y }` | `windows/image_drop.rs` | Window-scoped: that note | Note window: inserts at the drop point |
| `automations-changed` | `Automations` (the saved rules) | `commands/settings.rs` | App-wide | Note window, Settings |
| `checklist-reset` | `{ noteId }` | `src-tauri/src/automation.rs` (rule 2, when a repeating reminder fires) | Window-scoped: that note | Note window: claims it, then unticks |

**How the webview listens.** Tauri 2 delivers an `emit_to` event to plain `listen()`
listeners in every window. So the helpers for window-scoped events use `listenHere()` in
`src/ipc/events.ts`, which listens with the current webview window as target:
`note-action`, `privacy-changed`, `settings-section`, `note-resized`,
`note-settings-note`, `images-dropped` and `checklist-reset`. App-wide events use plain
`listen()`. This fixed DES-41, where Trash on one note's manager row could also trash
another open note ([PR #25](https://github.com/KRusselAlex/desknotes/pull/25),
[check](testing/des-41-window-events-verification.md)).

---

## 6. Features

Each section says what the user sees, where the code is, and where the design and the
real-app check are.

### 6.1 Notes and autosave

- **What the user sees:**
  - Each note is its own floating window, which keeps its place and size across restarts.
  - New: Ctrl+N. Hide: Ctrl+W or ✕. The note stays active and its window reopens from
    the manager.
  - A save status shows in the window.
  - Opening a note never changes its "edited" time.
- **How it works:**
  - `Autosave` (`src/features/notes/autosave.ts`) waits 500 ms after the last change,
    with no write per keystroke, then calls `save_note_content`.
  - `flush()` runs before hide, close and any save-all round, and when the note view
    unmounts, so no timer outlives it.
  - Rust validates the document, then derives the title and search text
    (`db/notes.rs` `save_content`).
  - If a save fails, the window stays open and shows the error, and quitting is blocked
    (`quit.rs`).
- **Code:** `src/features/notes/NoteWindow.tsx`, `autosave.ts`, `SaveStatus.tsx`;
  `commands/notes.rs`; `db/notes.rs`.
- **Design and check:** [design.md](design.md) §4 (Autosave),
  [m1-verification.md](testing/m1-verification.md).

### 6.2 Editor and text style

- **What the user sees:**
  - Rich text: bold, italic, underline, strike, code, headings, bullet, numbered and task
    lists, quotes, code blocks, horizontal rules, links.
  - Links are Ctrl+K to edit and Ctrl+click to open.
  - The **Aa** popover adds font, size, weight, text colour, highlight (4 colours) and
    alignment.
  - The note's **⋯** menu has a quick-action row.
- **How it works:** a Tiptap editor with only MIT packages (`extensions.ts`). The
  `textStyle` and `highlight` marks, with their allowed values, are checked in
  `validation.rs`.
- **Code:** `src/features/notes/FormatBar.tsx`, `TextStylePopover.tsx`, `textStyle.ts`,
  `LinkEditor.tsx`, `links.ts`; `crates/desknotes-core/src/validation.rs`.
- **Design and check:**
  [text-style spec](superpowers/specs/2026-11-03-text-style-design.md) and
  [check](testing/m3-text-style-verification.md);
  [note menu spec](superpowers/specs/2026-11-05-note-menu-design.md) and
  [check](testing/note-menu-verification.md).

### 6.3 Images in notes

- **What the user sees:**
  - Three ways to add an image: paste (Ctrl+V), drop an image file on the note, or the
    **Insert image…** button in the format bar.
  - PNG, JPEG, GIF and WebP are accepted, detected from the bytes. SVG and anything else
    is refused, and a message strip says why.
  - An image is its own block, with resize handles from 10 % to 100 % of the width.
    It lands where it was pasted or dropped.
  - A paste from Word or LibreOffice stays text.
- **How it works:**
  - WebKitGTK gives the page no clipboard images and no dropped files. So Rust reads
    them: `paste_image` (`platform/clipboard.rs`), drops in `windows/image_drop.rs`
    (sent back with `images-dropped`), and the picker in `pick_image`. No path crosses
    the webview.
  - Every image is decoded and re-encoded in `image_prep.rs`:
    - photos larger than 2000 px on a side are scaled down;
    - EXIF, GPS, comments and colour profiles are dropped;
    - no stored image is over 5 MB;
    - animated GIFs are never scaled.
  - Images are stored in the database by SHA-256 (`images`, `note_images`). The editor
    loads them through `desknotes-image://localhost/<id>` (`src/ipc/images.ts`).
  - The `image` node is in the allowlist in `validation.rs`. It may only sit in the
    document, a list item, a task item or a quote, with a width of 10–100.
  - While the lock is on, an image used only by locked private notes is not served.
  - Images no note uses are deleted only at start-up.
  - Backups (format 6) carry the images.
- **Code:** `src/features/notes/imageNode.ts`, `imageInput.ts`, `ImageMessage.tsx`,
  `FormatBar.tsx`; `src-tauri/src/commands/images.rs`, `windows/image_drop.rs`,
  `platform/clipboard.rs`; `crates/desknotes-core/src/image_prep.rs`, `db/images.rs`.
- **Design and check:** [spec](superpowers/specs/2026-11-06-images-in-notes-design.md),
  [check](testing/m3-images-verification.md).

### 6.4 Colours and appearance

- **What the user sees:**
  - Eight note colours: Lemon, Peach, Rose, Lilac, Sky, Mint, Sand, Paper.
  - Settings › Appearance has:
    - High-contrast notes (black on white);
    - Layout: Comfortable or Compact;
    - Default font and default size (10–32 px);
    - Reset appearance.
  - Changes apply live in every window.
- **How it works:**
  - The colour presets and contrast helpers are in `src/features/appearance/colors.ts`.
    Rust accepts any `#rrggbb` (`validate_color`).
  - The app appearance is four settings keys, saved in one transaction
    (`db/settings.rs` `set_app_appearance`). It is broadcast with
    `app-appearance-changed`.
  - Note windows read it before their first paint (`useAppAppearance.ts`).
- **Code:** `src/features/appearance/`, `src/features/settings/AppearancePane.tsx`,
  `src/features/notes/ColorPopover.tsx`, `commands/settings.rs`.
- **Design and check:**
  [spec](superpowers/specs/2026-11-04-appearance-settings-design.md),
  [check](testing/m3-appearance-verification.md).

### 6.5 Note settings

- **What the user sees:** a 400 px window beside the note. It sets:
  - background colour;
  - font, size, text colour, line spacing and direction (auto, LTR or RTL);
  - opacity (80–100 %);
  - exact size;
  - always on top, and read-only.

  Changes apply live; Escape closes the window.
- **How it works:**
  - `set_note_appearance` stores the `appearance` JSON.
  - When opacity crosses 100 %, the note window is told to `reopen`, because
    transparency is fixed when a window is created.
  - While the window is open, the note's size follows through `note-resized`.
- **Other note controls:**
  - **Always on top** and **read-only** (edit lock): the core refuses saves to a
    read-only note.
  - **Collapse:** the note rolls up to a 32 px header strip.
  - **Minimum note size:** set in Settings › General.
- **Code:** `src/features/note-settings/NoteSettingsWindow.tsx`,
  `src-tauri/src/windows/note_settings.rs`, `commands/note_settings.rs`.
- **Design and check:** [spec](superpowers/specs/2026-11-03-note-settings-design.md),
  [check](testing/m3-note-settings-verification.md). Always on top, collapse, edit lock
  and minimum size are checked in [m2-verification.md](testing/m2-verification.md).

### 6.6 Manager lists and search

- **What the user sees:**
  - Tabs: Active · Completed · Reminders · Archived · Trash, with counts.
  - The search field (Ctrl+F) matches anywhere in the text, ignoring case. Matching rows
    show a snippet, with the match highlighted.
  - Ctrl+N makes a new note.
  - Start-up errors are listed in the manager. A failed tray action opens the manager
    with its reason (`action-failed`).
- **How it works:**
  - `list_notes` runs `instr(search_text, query)` on the derived lower-case text.
  - A note is in exactly one list: Trash, else Archived, else Completed, else Active.
  - Completed sorts by the done date; the other lists sort by the last edit.
  - While the lock is on, a private note is listed under its label, and matches on its
    label only.
- **Code:** `src/features/manager/ManagerWindow.tsx`, `highlight.tsx`; `db/notes.rs`
  `list_notes`, `count_notes`.
- **Design and check:** [design.md](design.md) §5 (Manager window),
  [m1-verification.md](testing/m1-verification.md).

### 6.7 Archive, trash and completed

- **What the user sees:**
  - **Archive** hides a note and keeps it searchable under Archived.
  - **Trash** is recoverable: restore puts the note back where it was, and it reappears
    if it was active.
  - **Delete forever** only works from the trash.
  - **Mark done** (Ctrl+D or the menu) shows a "Marked done" strip with undo (Ctrl+Z).
    Then the window closes and the note moves to Completed. Reopening it opens the window
    again.
  - Automation rules can also archive done notes and empty old trash after some days
    (§6.8).
- **How it works:**
  - `set_archived`, `trash_note`, `restore_note`, `purge_note` and `set_completed` are in
    `db/notes.rs`.
  - Marking done touches only `completed_at`. Text, colour and reminder stay.
    `set_completed` reports whether the done state changed: reopening a note that is not
    done changes nothing, so a stale Reopen click never shows a hidden note.
  - A done, archived or trashed note gets no window and no Note settings window
    (`ensure_may_have_window` in `commands/notes.rs`).
  - When the action comes from the manager for an open note, the shell hands it to that
    window with `note-action`, so the window saves first.
- **Code:** `src/features/notes/DoneStrip.tsx`, `NoteWindow.tsx`, `ManagerWindow.tsx`,
  `commands/notes.rs`.
- **Design and check:**
  [completed spec](superpowers/specs/2026-11-05-completed-notes-design.md) and
  [check](testing/m4-completed-verification.md). Archive and trash: [design.md](design.md)
  §5.

### 6.8 Automation rules

- **What the user sees:** Settings › Automations has four rules, all off by default:
  1. **Mark a checklist done when every item is ticked.** Ticking the last item shows the
     "Marked done" strip with Undo, as Mark done does. This rule skips a note with a
     repeating reminder, so a routine stays open.
  2. **Untick a checklist when its repeating reminder goes off.**
     - An open note is unticked in the editor, as one undoable step, with a strip.
     - A closed note is changed in the database.
     - Locked, edit-locked, done, archived and trashed notes are skipped.
     - It runs once per occurrence.
  3. **Archive done notes after N days** (1–90, default 7).
  4. **Empty old trash after N days** (7–365, default 30). This is the only rule that
     deletes. Turning it on needs a confirmation dialog that says how many notes would go.
     Restoring a backup switches it off, keeping its days, and Automations says why.
- **How it works:**
  - The core owns what each rule changes (`db/automation.rs`). Days are counted as
    86 400 000 ms in UTC, never calendar days.
  - The shell owns when rules run (`src-tauri/src/automation.rs`). Rules 3 and 4 run:
    - once at start-up, before any window shows;
    - then hourly;
    - right after the settings change;
    - after an unlock.
  - Locked private notes are skipped.
  - Rule 1 runs in the note window (`checklist.ts`).
  - Rule 2 is triggered by the reminder scheduler. An open window gets `checklist-reset`,
    then claims it with `claim_checklist_reset` so it unticks once.
  - Only the Settings window may change the rules (`set_automations`,
    `enable_purge_trash`). Every window hears `automations-changed`.
- **Code:** `src/features/settings/AutomationsPane.tsx`, `src/features/notes/checklist.ts`,
  `DoneStrip.tsx`; `src-tauri/src/automation.rs`, `commands/settings.rs`;
  `crates/desknotes-core/src/db/automation.rs`.
- **Design and check:** [spec](superpowers/specs/2026-11-06-automation-rules-design.md),
  [check](testing/m4-automation-rules-verification.md).

### 6.9 Reminders

- **What the user sees:**
  - One reminder per note: a date, a time, and a repeat (none, daily, weekdays, weekly,
    monthly). It is set from the note's reminder popover.
  - The date is a native date field. The time is typed into a text field ("9:30", "0930",
    "14h", "9pm"…) and shows as 24-hour "HH:MM" once left: WebKitGTK's native time field
    never moves on from the hour (DES-45). A time it cannot read is marked red only once
    the field is left, and Save stays disabled until it reads.
  - A desktop notification shows the note's **title**, or "Private note" while it is
    locked, with buttons: 10 min, 1 h, Dismiss.
  - Clicking the notification opens the note.
  - The manager has a Reminders tab.
  - Reminders missed while DeskNotes was closed come as one summary notification at
    start-up. A click on it opens the manager.
- **How it works:**
  - All time rules are pure functions in `crates/desknotes-core/src/reminders.rs`. The
    reminder keeps the wall-clock time, so a time-zone change keeps it.
  - The scheduler thread in `src-tauri/src/reminders.rs` sleeps until the next due time,
    60 s at most.
  - It wakes at once when a reminder changes, at start, and on resume from sleep.
  - It re-anchors reminders when the UTC offset changes, and never sends a reminder
    twice.
  - Notifications go over D-Bus (`platform/notify.rs`), with one connection kept open.
  - When the lock engages, notifications that showed a now-locked title are closed.
- **Code:** `src/features/notes/ReminderPopover.tsx`, `reminderText.ts`, `timeInput.ts`;
  `src/features/manager/RemindersList.tsx`, `reminderGroups.ts`;
  `commands/reminders.rs`; `db/reminders.rs`.
- **Design and check:** [spec](superpowers/specs/2026-11-04-reminders-design.md),
  [check](testing/m4-reminders-verification.md).

### 6.10 Privacy lock and PIN reset

- **What the user sees:**
  - Any note can be made private, with an optional neutral label ("Private note" when it
    has none). Characters that are invisible or reorder text (bidi overrides and
    isolates, zero-width space, soft hyphen) are removed from labels, new or restored.
  - With a 6-digit PIN set, private notes are locked:
    - at start-up;
    - on sleep and on screen lock;
    - after 1, 5, 10 or 15 minutes with no input in DeskNotes (5 by default);
    - with "Lock now".
  - A locked note shows only its label. It still collapses to its strip and expands to
    the PIN pad, staying locked. Unlocking with the PIN unlocks all private notes. Wrong
    PINs bring growing waits.
  - If the PIN is forgotten, there are three ways back:
    - the Ubuntu password (polkit);
    - a 24-character recovery code, shown once;
    - as a last resort, `desknotes --reset-pin` in a terminal with DeskNotes closed.
      The manager then shows "The PIN was reset on …" until it is acknowledged.
  - Proving a forgotten PIN allows one new PIN. Changing, removing or setting up a PIN,
    or a lock, cancels that permission.
- **How it works:**
  - The core withholds text and refuses changes while locked (`db/mod.rs`).
  - Export and restore are refused while any private note is locked.
  - The shell decides when to lock (`src-tauri/src/privacy.rs`). It saves open notes
    first. A note whose save failed stays readable until its window closes.
  - The PIN is hashed with Argon2id (`privacy.rs`). PINs and codes are never logged.
  - Each hash takes about 0.33 s, so it never runs while the database lock is held:
    a check reads the stored hash (`start_check`), compares with the lock released,
    then records the result and acts on it in one hold (`finish_check`). New PINs and
    recovery codes (`NewPin`, `NewRecoveryCode`) are hashed before the lock is taken.
    This work runs on a blocking thread and takes turns (`AppState::secrets`), so
    the wrong-PIN waits cannot be raced past. A check whose PIN changed meanwhile is
    refused and records nothing. Locks are counted (`AppState::lock_epoch`): an unlock
    or recovery code whose check a lock overtook is refused ("Private notes were locked
    again"), so a screen lock or suspend during the check stays.
  - The Ubuntu password is asked with `pkcheck --process pid,start-time,uid`, the form
    pkcheck(1) asks for.
  - A lock checks again that a PIN is still set after the save round: turning the lock
    off during the round leaves nothing locked.
  - `--reset-pin` takes DeskNotes' single-instance name before it opens the database, and
    writes the "PIN was reset" notice and the PIN removal in one transaction. It lets the
    name go during the Ubuntu password prompt (a DeskNotes started then would wait on it
    and fail) and takes it again before writing, refusing if DeskNotes started.
- **Code:** `src/features/privacy/`, `src/features/settings/PrivacyPane.tsx`,
  `PinSetup.tsx`, `ChangePin.tsx`, `RecoveryCode.tsx`; `commands/privacy.rs`;
  `platform/lock_triggers.rs`, `platform/system_auth.rs`; `reset_pin.rs`;
  `db/privacy.rs`.
- **Design and check:** [spec](superpowers/specs/2026-11-02-privacy-lock-design.md)
  (D1–D14), [check](testing/m3-verification.md).

### 6.11 Backup and restore

- **What the user sees:**
  - Settings › Backup › Export saves `desknotes-YYYY-MM-DD.json` wherever the user
    chooses. The time of the last backup is shown.
  - Restore works in two steps:
    1. Choose a file: it is validated and a preview is shown. Nothing changes yet.
    2. Confirm: every note is replaced and the visible ones reopen.
- **How it works:**
  - Both export and restore first ask every open note to save.
  - Export writes to a temporary file, then moves it into place. It includes the images
    the notes use (format 6, at most 300 MiB).
  - Restore writes `backups/pre-restore-<ms>.db`, then replaces everything in one
    transaction. If "Empty old trash" was on, the same transaction switches it off
    (`purge_trash_off_by_restore`), because restored notes keep their old trash dates.
- **Code:** `src/features/settings/BackupPane.tsx`, `commands/backup.rs`,
  `crates/desknotes-core/src/backup.rs`, `db/backup.rs`.
- **Format and check:** [backup-format.md](backup-format.md),
  [m2-verification.md](testing/m2-verification.md) (Backup and restore).

### 6.12 Safe updates and releases

- **What the user sees:**
  - New versions are downloaded by hand from GitHub Releases (`.deb` or AppImage). There
    is no update check.
  - Upgrades copy the database first.
  - A database from a newer DeskNotes is never opened or changed, and a clear message
    explains why.
- **How it works:**
  - The pre-migration copy and the `SchemaTooNew` refusal are in `db/mod.rs`.
  - `crates/desknotes-core/tests/release_upgrade.rs` opens each released version's
    fixture database.
  - The release workflow (`.github/workflows/release.yml`) runs
    `scripts/release/check-tag.sh` before building. The release body comes from the
    CHANGELOG section.
- **Code:** `crates/desknotes-core/src/db/mod.rs`,
  `crates/desknotes-core/tests/release_upgrade.rs`,
  `scripts/release/`.
- **Docs and check:** [spec](superpowers/specs/2026-11-05-safe-updates-design.md),
  [upgrading.md](upgrading.md), [releasing.md](releasing.md),
  [check](testing/m5-safe-updates-verification.md).

### 6.13 Welcome note and About

- **What the user sees:**
  - **Welcome note:** on the very first start, a brand-new database gets one welcome
    note, centred on the primary screen. It never comes back after it is deleted.
  - **Settings › About:** the version and the OS name, with a Copy button that copies
    "DeskNotes <version> · <OS>". It has fixed
    links to the source code, issues, more tools, third-party notices and the licence.
- **How it works:**
  - The welcome note is created by `db/welcome.rs` `create_welcome_note`, and
    `first_run_done` records it.
  - `windows::place_welcome_note` centres it.
  - The OS name comes from os-release (`platform::os_name`).
  - Links go through `open_external_link`, which takes ids, not URLs.
- **Code:** `crates/desknotes-core/src/db/welcome.rs`,
  `src/features/settings/SettingsWindow.tsx`, `commands/settings.rs`.
- **Design and check:** [spec](superpowers/specs/2026-11-05-welcome-and-about-design.md),
  [check](testing/m5-welcome-about-verification.md).

### 6.14 Tray and shortcuts

- **Tray icon** (AppIndicator; the menu opens on left click too):
  - New note;
  - Hide all notes;
  - Show hidden notes;
  - Lock now (only while a PIN is set);
  - Open manager;
  - Settings…;
  - Quit DeskNotes.

  Hide and show run off the main thread, one at a time. A failure opens the manager with
  `action-failed`. Without a tray, the manager stays the way back. Code:
  `src-tauri/src/tray.rs`.
- **Show / hide all notes shortcut** (GNOME):
  - GNOME 46 has no global-shortcut portal, so Settings › General adds one GNOME custom
    keyboard shortcut, after the person confirms. It runs `desknotes --toggle-notes`.
  - The single-instance plugin passes that flag to the running app.
  - Code: `platform/gnome_shortcut.rs`, `src/features/settings/ShortcutRow.tsx`,
    `shortcut.ts`.
- **In-app keys:**

  | Window | Keys |
  |---|---|
  | Note | Ctrl+N new, Ctrl+W hide, Ctrl+K link, Ctrl+D mark done, Ctrl+Z undo while the done strip shows |
  | Manager | Ctrl+N new, Ctrl+F search |
  | Note settings | Escape closes |
- **Check:** [m2-verification.md](testing/m2-verification.md) (Tray icon, Hide all, Show
  hidden notes; Show / hide all shortcut).

### 6.15 Launch at login

- **What the user sees:** the Settings › General switch "Launch at login".
- **How it works:**
  - `tauri-plugin-autostart` writes or removes `~/.config/autostart/DeskNotes.desktop`.
  - `set_launch_at_login` returns the state actually in effect.
  - Nothing is stored in the database.
- **Code:** `commands/settings.rs`, `src/features/settings/SettingsWindow.tsx`.
- **Check:** [m2-verification.md](testing/m2-verification.md) (Settings window: General
  and About).

---

## 7. How to build, test and verify

- **Set up and run:** [README.md](../README.md) lists the Ubuntu build packages, or use
  `scripts/setup-ubuntu.sh`. [CONTRIBUTING.md](../CONTRIBUTING.md) has the run and build
  commands. `npm run tauri dev` starts the real app.
- **Mocked UI preview:** run `npm run dev`, then open
  `http://localhost:1420/preview.html?w=manager` (see `src/dev/preview.tsx` for the
  options).
- **Gate:** run these before every pull request. CI runs the same checks in
  `.github/workflows/ci.yml`.

  ```bash
  npm test && npm run lint && npm run typecheck
  cargo test -p desknotes-core
  cargo clippy --workspace --all-targets -- -D warnings
  ```
- **Real-app checks on Ubuntu:**
  - Use the `desknotes-verify-ubuntu` skill (`.claude/skills/`) and the tools in
    `scripts/verify/`. They use isolated test data, never your real notes.
  - Record each check in [docs/testing/](testing/).
- **Releasing:** [releasing.md](releasing.md).
