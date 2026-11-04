# DeskNotes — Design (Milestone 0)

Status: accepted for Milestone 1 · Date: 2026-11-01
Source requirements: the project *cahier des charges* (sections 1–20).

This document records the environment, the decisions taken, the risks, and the
milestone plan. Architecture decisions with trade-offs live in `docs/adr/`.

---

## 1. Development environment (inspected 2026-11-01)

| Item | Value |
|---|---|
| OS | Ubuntu 24.04.5 LTS (noble), x86_64 |
| Desktop | GNOME (`ubuntu:GNOME`), **Wayland** session, XWayland available |
| GPU | Intel Meteor Lake-P integrated graphics |
| CPU / RAM | 14 threads / 30 GiB |
| Rust | rustc 1.99.0, cargo 1.99.0 (rustup) |
| Node | 24.11.0, npm 11.6.1, pnpm 10.27.0 |
| Git / gh | git 2.43.0, gh 2.45.0, authenticated as `KRusselAlex` (scopes include `repo`, `workflow`) |
| WebKitGTK runtime | `libwebkit2gtk-4.1-0` 2.52.6 installed |
| WebKitGTK **dev** | **missing** → required one-time `apt install` (below) |

### Required one-time system setup (needs sudo)

```bash
sudo apt update
sudo apt install libwebkit2gtk-4.1-dev libsoup-3.0-dev libjavascriptcoregtk-4.1-dev \
  librsvg2-dev libxdo-dev libayatana-appindicator3-dev patchelf
```

Already present: `build-essential`, `curl`, `wget`, `file`, `libssl-dev`, `libgtk-3-dev`, `pkg-config`.
`sqlite3` CLI is **not** required: SQLite is compiled into the app (`rusqlite` `bundled`).

---

## 2. Dependency verification (versions checked against npm / crates.io on 2026-11-01)

All core dependencies are free and open source. None requires a paid service, account or network.

| Dependency | Version | License | Why |
|---|---|---|---|
| tauri / tauri-build / @tauri-apps/cli, api | 2.12.x | MIT OR Apache-2.0 | Desktop shell using system WebKitGTK |
| tauri-plugin-single-instance | 2.5.5 | MIT OR Apache-2.0 | Prevent duplicate instances; relaunch shows manager |
| tauri-plugin-opener | 2.7.2 | MIT OR Apache-2.0 | Open http(s)/mailto links in the system browser |
| tauri-plugin-autostart (M2) | 2.7.0 | MIT OR Apache-2.0 | Launch at login |
| tauri-plugin-dialog (M2) | 2.8.4 | MIT OR Apache-2.0 | Backup file pickers |
| tauri-plugin-notification (M4) | 2.8.0 | MIT OR Apache-2.0 | Local OS notifications |
| rusqlite (`bundled`) | 0.41.1 | MIT (SQLite: public domain) | Native SQLite access |
| serde / serde_json / thiserror / uuid | current | MIT OR Apache-2.0 | Serialization, errors, stable IDs |
| argon2 (M3) | 0.6.0 | MIT OR Apache-2.0 | PIN hashing (Argon2id) |
| zbus (M3, Linux only; blocking API) | 5.13.2 | MIT | Listen for sleep and screen-lock signals on the local D-Bus to lock private notes. Already in the build through Tauri's plugins; no network |
| react / react-dom | 19.3.1 | MIT | UI |
| vite / @vitejs/plugin-react | 8.3.5 / 6.1.2 | MIT | Build tooling |
| typescript | **6.0.3** (pinned) | Apache-2.0 | Type checking. 7.0 exists but typescript-eslint supports `<6.1` |
| @tiptap/* (react, starter-kit, pm, extension-list, …) | 3.32.2 | MIT | Rich-text editor. **Only the MIT open-source packages** are used. Tiptap "Pro"/cloud extensions are paid and are **not** used |
| @tiptap/extension-text-style | 3.32.2 | MIT | Text style mark carrying font family, size, weight and colour (the Aa popover) |
| @tiptap/extension-highlight | 3.32.2 | MIT | Highlight mark with one of four colours |
| @tiptap/extension-text-align | 3.32.2 | MIT | Left, centre or right alignment of paragraphs and headings |
| @tiptap/extension-bold | 3.32.2 | MIT | Already in the build through the starter kit; imported directly to adjust how pasted font weights are read, so a Medium or Semibold weight is not also read as bold |
| vitest / @testing-library/react / jsdom | 5.0.5 / 16.3.3 / 30.1.3 | MIT | Frontend tests |

Not used, deliberately: `tauri-plugin-sql` (see ADR-0003), Tailwind (organized CSS is enough),
zod (validation is enforced on the Rust side, ADR-0003), any Tiptap Pro / Collaboration / Cloud package.

**Costs, honestly stated.** The *application* costs nothing to run. Development tools
(Rust, Node, Tauri) are free. GitHub public repositories and GitHub Actions for public
repositories are free today but subject to GitHub's usage limits and terms. Claude Code is
a paid development tool used to *write* the project; the app never needs it.

---

## 3. Platform reality on Ubuntu GNOME Wayland (ADR-0002)

Native Wayland does **not** let an application place its own windows at global
coordinates, read its global position, or set itself "always on top". GTK on Wayland
silently ignores these requests. A sticky-note app needs all three.

**Decision:** on Linux Wayland sessions DeskNotes runs its windows through **XWayland**
(`GDK_BACKEND=x11`) by default. Under XWayland, Mutter honours window positions and the
"keep above" hint. Users can force native Wayland with `DESKNOTES_BACKEND=wayland`, in which
case position restoration and always-on-top are reported as unsupported in the UI.

Trade-offs, stated up front:
- With **fractional** display scaling, XWayland windows can look slightly blurry. Integer
  scaling (100 %, 200 %) is sharp. Your machine currently reports scaling factor 0 (auto).
- This is a portability *adapter* decision: Windows and macOS do not need it.
- **Not yet verified on this machine.** It becomes verified only after the first build runs.

Pinning notes *behind* windows onto the wallpaper is out of scope (optional, later).

---

## 4. Architecture (ADR-0001, ADR-0003, ADR-0004)

Modular monolith, three layers:

```
┌────────────────── React + TypeScript (shared UI, every OS) ──────────────────┐
│ app/ (window router)  features/notes  features/manager  features/appearance  │
│ ipc/ (typed command wrappers — the ONLY place that calls invoke())           │
└──────────────────────────────────┬───────────────────────────────────────────┘
                                   │ Tauri IPC (typed commands + events)
┌──────────────────────── src-tauri (desktop adapter) ─────────────────────────┐
│ commands/  thin handlers: deserialize → call core → emit change events       │
│ windows/   create / restore / track geometry of note windows (OS specifics) │
│ platform/  Wayland→XWayland selection, future Windows/macOS specifics        │
└──────────────────────────────────┬───────────────────────────────────────────┘
                                   │ plain Rust calls
┌──────────────── crates/desknotes-core (pure Rust, no GUI deps) ──────────────┐
│ model, validation (rich-text allowlist), db (migrations, repository),        │
│ geometry (keep-on-screen), later: privacy (Argon2id, throttle), reminders    │
└──────────────────────────────────────────────────────────────────────────────┘
```

- `desknotes-core` builds and tests on any OS **without** WebKitGTK. All business rules
  and every SQL statement live there. This is the cross-platform core of section 20.
- The frontend never sends SQL. It calls named commands (`create_note`, `save_note_content`…).
  This is what makes the M3 privacy lock enforceable in the native layer.
- **Single source of truth:** the SQLite database, owned by the Rust process. Windows
  hold only a working copy of the note they display and receive `note-changed` events.

### Windows and how they communicate

- One **manager** window (label `manager`) and one window per visible note
  (label `note-<uuid>`). The React bundle is shared; `main.tsx` routes by window label.
- Windows are created **only by Rust** (`windows::open_note`). The frontend asks via a command.
- Geometry: Rust listens to `Moved`/`Resized`, debounces 400 ms, writes `note_windows`.
  On startup it restores every visible note at its saved place, clamped back on-screen.
- Change propagation: every mutating command emits `note-changed { id }` (or
  `notes-changed`) to all windows. The manager refreshes its list; a note window
  re-reads its appearance. Content is edited in exactly one window, so there is no
  merge problem in M1.
- Closing a note window **hides** the note (it stays saved). Closing the manager hides
  it while notes are visible; relaunching DeskNotes (single instance) shows it again.
  "Quit" is an explicit manager action.

### Data model (migration 1)

```
notes        id TEXT PK (UUIDv4), title TEXT, content_json TEXT, color TEXT (#rrggbb),
             created_at INTEGER, updated_at INTEGER (Unix ms, UTC),
             archived_at INTEGER NULL, deleted_at INTEGER NULL,  -- soft delete = trash
             edit_locked INTEGER (migration 2: read-only note)
note_windows note_id PK→notes ON DELETE CASCADE, x, y, width, height REAL (logical px),
             visible INTEGER, always_on_top INTEGER
settings     key TEXT PK, value TEXT
```

Reminders and automation tables arrive with their milestones as new migrations.
Before applying any pending migration to an existing database, the core writes a
consistent copy with `VACUUM INTO` to `backups/pre-migration-v<N>-<time>.db`.

### Rich text safety

Content is Tiptap/ProseMirror **JSON**, never HTML. The core validates every save:
size ≤ 1 MiB, depth ≤ 64, node and mark types from an allowlist, and link `href`
restricted to `http`, `https`, `mailto`. A `javascript:` link is rejected by the native
layer even if the UI is bypassed. A shared fixture (`tests/fixtures/rich-doc.json`) is
checked by both the Rust validator tests and the editor round-trip test, so the two
sides cannot drift apart silently.

### Autosave

Per note window: debounce 500 ms after the last change, forced save at most every
2 s during continuous typing, immediate flush on blur, hide and close. At most one save
is in flight; newer content waits and replaces any queued content (no out-of-order
writes). A failed save shows a persistent "Not saved — retry" state and keeps the
unsaved content in memory. Known residual risk: a hard kill (power loss, `kill -9`)
can lose up to ~500 ms of typing.

---

## 5. Interface

### Note window (compact)

```
┌──────────────────────────────────────────┐
│ ⠿  B I U S  H  • 1. ☑  🔗  🎨      ⋯  ✕ │  ← header = drag area; formatting
├──────────────────────────────────────────┤     buttons fade in on hover/focus
│ Call the bank before Friday              │
│ ☐ passport photos                        │
│ ☑ renew insurance                        │
│                                          │
│                              saved ✓     │  ← save state (error is persistent)
└──────────────────────────────────────────┘
```

- `🎨` opens the colour presets. `⋯` menu: New note, Duplicate, Open manager, Archive, Move to trash.
- Links: `Ctrl+click` opens in the default browser; plain click edits.
- Window title is always "DeskNotes" so content never leaks to the taskbar (privacy-ready).
- Shortcuts: Ctrl+B/I/U, Ctrl+Shift+X strike, Ctrl+Alt+1–3 headings, Ctrl+Shift+7/8/9
  lists, Ctrl+K link, Ctrl+Z / Ctrl+Shift+Z, Ctrl+N new note, Ctrl+W hide note.

### Manager window

```
┌ DeskNotes ─────────────────────────────────────────────┐
│ [ + New note ]   [ search…             ]     [ Quit ]  │
│ Active (12) │ Archived (3) │ Trash (1)                 │
├────────────────────────────────────────────────────────┤
│ ▌Call the bank before Friday     edited 10:42  [Show]  │
│ ▌Wi-Fi password for guests       edited Mon    [Hide]  │
│ …                                       [Archive] [🗑]  │
└────────────────────────────────────────────────────────┘
```

Trash shows **Restore** and **Delete permanently** (with confirmation). Settings,
reminders and lock screens are added by their milestones.

Visual direction: paper-like notes with soft presets (lemon, peach, mint, sky, lilac,
rose, sand, white), dark ink text with ≥ 4.5:1 contrast on every preset, system font
stack (`system-ui, "Ubuntu", "Cantarell", "Segoe UI", sans-serif`) for portability.

---

## 6. Milestone plan

**M0 — Environment and design** (this document, ADRs). Done when this file is reviewed.

**M1 — First usable MVP**
1. Repository skeleton, workspace, licenses, `.gitignore`.
2. `desknotes-core`: migrations, repository (create, update, duplicate, archive,
   restore, trash, purge, list, search), validation, geometry, Rust tests.
3. Frontend: editor (Tiptap, basic formatting + checklists + links), toolbar, colour
   presets, autosave, manager with search and Active / Archived / Trash. Vitest tests.
4. `src-tauri`: commands, note windows, geometry persistence, startup restoration,
   single instance, XWayland selection.
5. Build and **manually verify** on this Ubuntu session; record results in `docs/testing/`.

**M2 — Desktop reliability** (done, 0.2.0): always-on-top toggle, show/hide all (tray,
manager and a GNOME keyboard shortcut), minimum size setting, keeping notes on screen
when monitors change, launch at login, backup/restore (JSON export + SQLite copy), tray
(AppIndicator), `.deb`/AppImage packaging, CI. "Reset size" moved to the per-note Size
card (M3, DES-19).

**M3 — Customization and privacy**: fonts, size, weight, text/highlight colours,
alignment, case transform, high-contrast + compact layouts, reset appearance; privacy lock
(Argon2id PIN, throttling, native enforcement, suspend/screen-lock detection via
logind / GNOME ScreenSaver D-Bus), PIN change and documented recovery.

**M4 — Productivity**: due dates, reminders (UTC storage, time-zone & DST tests),
recurrence, snooze, notification overview, limited rule-based automations.

**M5 — Public release**: E2E tests (tauri-driver + WebKitWebDriver where practical),
docs, release workflow, release notes, public repository (only after your confirmation).

Windows and macOS ports follow M5 (section 20.7) and are claimed only after real builds.

## 6b. Read-only notes (decided 2026-11-01)

An edit-locked note is **fully frozen**: text, formatting and checklist boxes cannot
change until it is unlocked. The core refuses every content save while
`edit_locked` is set, so the interface and the native layer agree. Empty checklist
boxes are drawn dashed to show they are inert (design state N17).

## 7. Forgotten PIN (decided for M3 — see docs/superpowers/specs/2026-11-02-privacy-lock-design.md D5, D6, D11, D14)

Built: the owner chooses in Settings → Privacy between the Ubuntu password (polkit, with the
`.deb`) and a recovery code; `desknotes --reset-pin` is the last resort and is announced at
the next start. Operating-system unlock on Windows/macOS (Windows Hello, Touch ID) remains
for when those platforms are built. The original proposal follows.

### Original proposal

The lock protects notes from someone looking at an unlocked screen. It does not
encrypt the database, so recovery can be offered without weakening the real
guarantee. Proposed layers, strongest first:

1. **Recovery code.** When the PIN is first set, DeskNotes shows a one-time code
   (for example 6 groups of 4 characters) to write down or print. Only its Argon2id
   hash is stored. Entering it unlocks and forces a new PIN, and a new code is issued.
2. **Offline reset, made visible.** With DeskNotes closed, `desknotes --reset-pin`
   from a terminal removes the PIN. The next start shows a banner "The PIN was
   reset on <date>" that cannot be dismissed silently, so a reset by someone else is
   noticed. This is honest: anyone who can run commands as you can already read the
   database file.
3. **Later, optional:** unlock with the operating-system account (polkit on Linux,
   Windows Hello, Touch ID) where a maintained API exists.

Never: e-mail or SMS recovery, security questions, or any online service.
If database encryption is added later, the recovery code must also protect the
encryption key, and losing both PIN and code would then mean losing the notes.
That trade-off must be shown to the user before encryption is enabled.

## 8. Performance plan

No numbers are claimed yet. After M1 builds, measure on this machine: cold start to first
note visible, idle CPU over 60 s, RSS of the core process plus all `WebKitWebProcess`
children with 1, 10 and 30 visible notes, and save latency. WebKitGTK may spawn one web
process per window; if 30 windows prove too heavy, the mitigation is to create windows
only for *visible* notes (already the design) and consider sharing a process pool.
