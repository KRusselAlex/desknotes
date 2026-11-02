# Changelog

All notable changes are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

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
