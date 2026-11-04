# Changelog

All notable changes are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- Private notes with a privacy lock (Milestone 3): mark a note private from its ⋯ menu,
  with an optional label. A 6-digit PIN (Settings → Privacy) locks every private note; a
  locked note shows only its colour and label, never its text or title, in every window,
  in the manager and in search.
- Locks by itself when the computer sleeps, when the screen locks, and after 1, 5, 10 or 15
  minutes without using DeskNotes; also "Lock now" in the tray, the manager and Settings.
  Notes are saved first, so locking never loses typing.
- Wrong PINs make you wait (30 s, then 1 min, then 5 min), also after a restart.
- Forgotten PIN: "If I forget my PIN" in Settings chooses the way back — the Ubuntu
  password (with the `.deb`) or a recovery code shown once. Last resort:
  `desknotes --reset-pin` with DeskNotes closed; the next start says so.
- Backups keep private notes private (backup format 2); export and restore ask for the
  PIN while private notes are locked.
- Note settings for one note (⋯ → Note settings…): font from the fonts on this computer,
  text size, text colour, line spacing, direction (automatic per paragraph, left-to-right,
  right-to-left), background colour, see-through background down to 80 %, width and height
  with "lock aspect ratio" and "Reset size", lock editing and always on top. Changes show
  at once and are kept after a restart, by Duplicate and in backups (backup format 3).

### Changed
- Settings opens at a given section from other windows (for example Privacy).

## [0.2.0] — 2026-11-02 — Milestone 2: desktop reliability

### Added
- Keyboard shortcut to show / hide all notes (Settings → General). Ubuntu 24.04 has no
  global-shortcut service for apps, so DeskNotes adds one GNOME custom shortcut, after you
  confirm, that runs `desknotes --toggle-notes`; it warns when the keys are already used.
- `desknotes --toggle-notes`: hides every note, or brings back the hidden ones; starts
  DeskNotes if it is not running.
- Minimum note size (Settings → General, 180–600 × 120–600 px).
- Tray icon (Ubuntu AppIndicator) with New note, Hide all notes, Show hidden notes, Open
  manager, Settings and Quit.
- Hide all notes / Show hidden notes, also in the manager menu.
- Installable `.deb` package (about 10 MB) with proper metadata and license, tested on a
  clean Ubuntu 24.04; AppImage built in CI for other distributions; release workflow that
  drafts a GitHub release from a version tag.
- Backup and restore of all notes as a documented JSON file (Settings → Backup), with a
  safety copy before every restore.
- Settings window: launch at login, colour for new notes, About (version, data folder).
- Always on top: pin a note above other windows (header pin or ⋯ menu).
- Collapse a note to its header strip; it reopens collapsed and keeps its full size.
- When a save fails, the reason is shown on hover over "Not saved" and written to the log
  (never the note's text).

### Changed
- Note windows share one WebKit process on Linux: about 70 % less memory with many notes.

### Fixed
- A link pasted from a web page (for example with `target="_self"`) made the note
  impossible to save: "Not saved", and Quit refused. Notes stuck this way save on Retry.
- A note left on a monitor that is no longer connected reopened off-screen; notes now
  open fully on a screen, keeping their size.

## [0.1.0] — 2026-11-01 — Milestone 1: first usable version

### Added
- Note window and manager rebuilt from the Milestone 1 design: header controls on
  hover, bottom formatting bar while editing, list-type menu, colour picker, read-only
  notes, inline link editor and hint, save-failure message, narrow layouts, manager
  tabs with counts, search with highlighted matches, date groups, dark theme.
- Edit lock (read-only notes), enforced in the core.
- Core: SQLite storage with migrations and backups, validation, trash and restore.
- Continuous integration on GitHub Actions: core, frontend and Linux app build.
- Claude Code project rules, skills and a review agent (`CLAUDE.md`, `.claude/`).
- Verification report for Milestone 1 on Ubuntu 24.04 (`docs/testing/`).
- Design document, milestone plan and architecture decision records (Milestone 0).
- Repository, license and contribution guidelines.

### Fixed
- Notes no longer grow 37 px taller on every restart (Ubuntu/XWayland).
- Opening or focusing a note no longer marks it as edited.
