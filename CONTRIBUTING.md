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

## Setting up (Ubuntu)

```bash
git clone https://github.com/KRusselAlex/desknotes.git && cd desknotes
scripts/setup-ubuntu.sh            # installs what is missing, then checks the build
scripts/setup-ubuntu.sh --check    # only reports what is missing
```

Tool versions are pinned: Rust in `rust-toolchain.toml` (rustup installs it on first
use) and Node.js in `.nvmrc` (`nvm use` picks it up). CI uses the same pins.
Docker is not needed for development: the app needs your desktop session.

## Development commands

```bash
npm install                 # frontend dependencies
npm test                    # frontend tests (Vitest)
npm run lint                # ESLint
npm run typecheck           # TypeScript
cargo test -p desknotes-core                         # core tests, no GUI libraries needed
cargo clippy -p desknotes-core --all-targets -- -D warnings
npm run tauri dev           # run the desktop app (needs the Ubuntu packages in README)
```

### UI preview without the desktop app

`npm run dev`, then open:

- `http://localhost:1420/preview.html?w=manager` — the manager
- `http://localhost:1420/preview.html?w=note&id=a2` — a note window (resize the
  browser to 300 × 280 to see the real size)
- add `&locked=1` (read-only note), `&failsave=1` (saves fail) or `&error=1`
  (manager startup error)

The preview runs the real React screens with Tauri's official IPC mocks and an
in-memory fake database (`src/dev/preview.tsx`). It is never part of the app build.

### Building and releasing packages

```bash
npm run tauri build -- --bundles deb   # target/release/bundle/deb/DeskNotes_<version>_amd64.deb
```

The AppImage is built only in CI (the **Packages** workflow), because its tool downloads
helper programs. Pull requests that change packaging get both files as workflow
artifacts for testing.

To release: set the same version in `src-tauri/tauri.conf.json`, `Cargo.toml` and
`package.json`, update `CHANGELOG.md`, merge, then push a tag `v<version>`. The
`Packages` workflow tests, builds the `.deb` and AppImage with a `SHA256SUMS` file and creates a
**draft** release; review it and publish it by hand.

### Design

Visual design comes from the Milestone 1 design export (Claude Design).
Tokens live in `src/styles/tokens.css` and icons in `src/components/icons.ts`;
use them instead of new colours or sizes. `docs/ui-design-brief.md` lists the screens and states.

## Architecture decisions

Significant decisions get a short record in `docs/adr/` (context, decision,
consequences). Add one when you change a cross-cutting choice.
