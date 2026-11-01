# Changelog

All notable changes are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- Settings window: launch at login, colour for new notes, About (version, data folder).
- Always on top: pin a note above other windows (header pin or ⋯ menu).
- Collapse a note to its header strip; it reopens collapsed and keeps its full size.

### Changed
- Note windows share one WebKit process on Linux: about 70 % less memory with many notes.

### Fixed
- Notes no longer grow 37 px taller on every restart (Ubuntu/XWayland).
- Opening or focusing a note no longer marks it as edited.

### Added
- Continuous integration on GitHub Actions: core, frontend and Linux app build.
- Claude Code project rules, skills and a review agent (`CLAUDE.md`, `.claude/`).
- Verification report for Milestone 1 on Ubuntu 24.04 (`docs/testing/`).
- Note window and manager rebuilt from the Milestone 1 design: header controls on
  hover, bottom formatting bar while editing, list-type menu, colour picker, read-only
  notes, inline link editor and hint, save-failure message, narrow layouts, manager
  tabs with counts, search with highlighted matches, date groups, dark theme.
- Edit lock (read-only notes), enforced in the core.
- Core: SQLite storage with migrations and backups, validation, trash and restore.
- Design document, milestone plan and architecture decision records (Milestone 0).
- Repository, license and contribution guidelines.
