# DeskNotes — instructions for Claude Code

DeskNotes is an offline sticky-note desktop app: Tauri 2 + React/TypeScript + SQLite,
Ubuntu first, Windows/macOS later. Read `docs/design.md` and `docs/adr/` before changing
architecture. The owner's full requirements are in the M0 design and the Jira board.

## Non-negotiables
- No network access, telemetry, accounts or paid services in the app. Anything that
  would contact a server must be opt-in and explained first.
- Data safety first: never drop or rewrite user data in a migration; append migrations,
  never edit shipped ones; the core backs up before upgrading.
- All SQL lives in `crates/desknotes-core`. The webview calls named Tauri commands only
  (`src/ipc` is the only place allowed to call `invoke`). Validate everything in Rust.
- Note content is validated Tiptap JSON, never HTML. New editor nodes/marks must be added
  to the allowlist in `crates/desknotes-core/src/validation.rs` and the shared fixture.
- Window titles, notifications and previews never show note text.
- Do not claim something works without testing it; record real-app checks in `docs/testing/`.

## Design
Screens follow the owner's Claude Design exports. Use `src/styles/tokens.css` and
`src/components/icons.ts`; do not invent colours, sizes or icons. If a screen has no
design yet, ask the owner. See the `desknotes-build-from-design` skill.

## Commands
```bash
npm test && npm run lint && npm run typecheck
cargo test -p desknotes-core
cargo clippy --workspace --all-targets -- -D warnings
npm run tauri dev                      # real app (Ubuntu packages listed in README)
npm run dev  # then http://localhost:1420/preview.html?w=manager  (mocked UI preview)
```
Real-app checks on Ubuntu: see the `desknotes-verify-ubuntu` skill and `scripts/verify/`.

## Workflow
- GitHub Flow on https://github.com/KRusselAlex/desknotes; never push to `main` directly
  without the owner's agreement. Conventional Commits with a `Refs: DES-n` footer.
- Work is tracked on Jira project DES (benintours.atlassian.net). Move issues as work
  lands; mark Done only after real testing.
- Platform-specific code stays in `src-tauri/src/windows` and `src-tauri/src/platform`.

## Known platform facts (verified 2026-11-01, Ubuntu 24.04 GNOME Wayland)
- Windows run through XWayland (`GDK_BACKEND=x11`, ADR-0002); positions and sizes restore.
- Note windows must be created hidden and then shown, or Mutter adds 37 px to their height.
- Each window costs one WebKit web process (~80 MiB); see Jira DES-24.
