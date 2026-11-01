# ADR-0001: Modular monolith with a pure-Rust core crate

Status: Accepted · 2026-11-01

## Context
DeskNotes must start on Ubuntu but later build on Windows and macOS without a rewrite.
Business rules (persistence, validation, privacy, reminders) must be testable without
a desktop session, and must not depend on WebKitGTK.

## Decision
A Cargo workspace with two crates and one React frontend:
- `crates/desknotes-core`: models, validation, SQLite migrations and repository, geometry
  rules, later privacy and scheduling. No Tauri, GTK or WebKit dependency.
- `src-tauri`: the desktop adapter. Thin commands, window management, platform specifics.
- `src/`: React + TypeScript UI shared by every OS.

## Consequences
- Core tests run on any CI runner without system GUI libraries.
- Platform differences are confined to `src-tauri/src/windows` and `src-tauri/src/platform`.
- Slightly more boilerplate: commands map core errors to IPC errors.
