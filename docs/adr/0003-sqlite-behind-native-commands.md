# ADR-0003: SQLite accessed only from Rust through named commands

Status: Accepted · 2026-11-01

## Context
`tauri-plugin-sql` lets the frontend run arbitrary SQL strings. That is convenient but
means the webview can read or change any data. The privacy lock (M3) must be enforced
in the native layer, and a webview-side SQL API cannot be restricted per note.

## Decision
- Use `rusqlite` with the `bundled` feature (SQLite compiled in, public domain; no
  system `libsqlite3-dev` needed, identical SQLite on every OS).
- All SQL lives in `desknotes-core::db`. The frontend calls named Tauri commands with
  typed, serde-validated arguments. No command accepts SQL.
- One connection behind a mutex, WAL journal, `foreign_keys=ON`, related writes in
  transactions. Versioned migrations via `PRAGMA user_version`; a `VACUUM INTO`
  backup is taken before upgrading an existing database.
- Timestamps are Unix milliseconds in UTC; conversion to local time happens in the UI.

## Consequences
- A future lock check is one guard in the command layer, covering every data path.
- Responses are produced by Rust types, so the TypeScript side mirrors them in
  `src/types`. A contract fixture is tested on both sides.
