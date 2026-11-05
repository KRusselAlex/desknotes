# Changelog

All notable changes are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

Database: migrations 4–7 (private notes, appearance, reminders, completed notes); backup format 5. A copy is made before upgrading.

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
- Text style for selected text (Aa at the end of the formatting bar, or "Text style…" in a
  narrow note): font, size, weight, six text colours, four highlights, align left / centre /
  right, UPPERCASE / lowercase, undo / redo. Text pasted from other apps takes the note's
  look; formatting copied inside DeskNotes is kept. Ctrl+Shift+H highlights in yellow.
- Settings → Appearance: high-contrast notes (white, black ink, thick lines and focus
  rings), compact or comfortable layout, a default font and text size for notes without
  their own, and Reset appearance. Applies to every open note at once; a note's own Note
  settings still win, and nothing is changed in the notes themselves.
- Reminders (Milestone 4): ⋯ → Set reminder… on a note, with date, time and repeat (none,
  daily, weekdays, weekly, monthly). A bell chip in the note shows when it is due. At that
  time a desktop notification shows the note's title ("Private note" while locked) with
  10 min, 1 h, Dismiss and Tomorrow. The manager has a Reminders tab (Today, Tomorrow,
  Later, overdue first). Reminders missed while DeskNotes was closed appear once at the next
  start; repeats keep their clock time across daylight-saving changes. Backups include
  reminders (backup format 4).
- Completed notes (Milestone 4): ⋯ → Mark as done (or Ctrl+D) shows "Marked done · Undo"
  for 5 seconds, then the note leaves the desktop. The manager's Completed tab lists done
  notes with when they were done, Reopen and Move to trash; Reopen puts the note back where
  it was. Reminders on done notes don't fire. Backups keep the done date (backup format 5).
- Upgrade test with a real 0.2.0 database; plain message when notes come from a newer
  DeskNotes (also in Forgot PIN).
- Releasing and upgrading guides (`docs/releasing.md`, `docs/upgrading.md`), including how
  to roll back to an older version.

### Changed
- The note's ⋯ menu is shorter: a row of New, Duplicate, On top and Lock at the top (pressed
  ones are shaded), then the rest of the list; "Private" opens its own short list in place.
  It fits a default-size note.
- Settings opens at a given section from other windows (for example Privacy).
- Release workflow: tags must be on main, full checks before building, beta tags make
  pre-releases, release notes come from this file, packages get a provenance attestation.

### Fixed
- A note with a reminder chip at 300 px wide no longer has a header wider than the window
  (which could shift the note sideways on a click); the date gives way first, then the
  "Read-only" word, so the reminder time stays whole.
- A database from a newer DeskNotes is no longer modified when it is refused.

## [0.2.0] — 2026-11-02 — Milestone 2: desktop reliability

Database: migration 3 (collapsed notes); backup format 1.

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

Database: migrations 1–2 (first version).

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
