# Contributing to DeskNotes

Thank you for helping. DeskNotes aims to stay small, private and reliable, so changes
are reviewed against those goals.

## Ground rules

- No network access, telemetry, accounts or paid services in the core application.
- New dependencies need a short justification in the pull request: license, why it is
  needed, maintained status, and Linux/Windows/macOS compatibility.
- Never commit note data, databases, secrets or machine-specific configuration.
- Keep platform-specific code in `src-tauri/src/windows` or `src-tauri/src/platform`.
- All SQL lives in `crates/desknotes-core`. The frontend never sends SQL.

## Workflow

We use GitHub Flow: branch from `main`, open a pull request, merge after review and green CI.

Branch names: `feat/short-topic`, `fix/short-topic`, `docs/short-topic`.

Commits follow [Conventional Commits](https://www.conventionalcommits.org/):

```
feat(core): add soft delete for notes

Explain why, not what.

Refs: DES-12
```

Common scopes: `core`, `ui`, `shell`, `db`, `docs`, `ci`.

## Project layout

| Path | Contents |
|---|---|
| `crates/desknotes-core` | Platform-independent Rust: models, validation, SQLite |
| `src-tauri` | Desktop adapter: Tauri commands, windows, platform code |
| `src` | React + TypeScript interface |
| `tests/fixtures` | Data shared by Rust and TypeScript tests |
| `docs/` | Design and architecture decision records |

## Development commands

Commands are documented here as each part of Milestone 1 lands.

## Architecture decisions

Significant decisions get a short record in `docs/adr/` (context, decision,
consequences). Add one when you change a cross-cutting choice.
