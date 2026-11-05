# Safe Updates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** prove that upgrading from the last release keeps every note, explain a too-new database in plain words, and make the release workflow enforce the owner's release safety rules. Delivery stays manual .deb/AppImage (owner decision).

**Architecture:**
- **Fixture:** a committed SQLite database made by the v0.2.0 code, plus a manifest, drives a core integration test.
- **Start-up message:** a start-up message mapping in the shell.
- **Release:** `release.yml` gains a main-branch check, the full gate, beta pre-releases, CHANGELOG-based notes and build provenance.
- **Docs:** two documents.

**Tech Stack:** Rust (desknotes-core tests), bash, GitHub Actions, Markdown.

**Spec:** `docs/superpowers/specs/2026-11-05-safe-updates-design.md`

## Global Constraints

- **Branch and commits:** branch `feat/safe-updates` from `main`. Conventional Commits with the footer `Refs: DES-22` and `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never stage `.superpowers/`.
- **No network in the app.** No update check or plugin.
- **Never edit shipped migrations.**
- **Message, verbatim:** "Your notes were saved by a newer version of DeskNotes. Install that version (or newer) to open them; nothing was changed."
- **Beta tags** `vX.Y.Z-beta.N` make pre-release drafts. Plain `vX.Y.Z` tags make normal drafts. Both must match `tauri.conf.json` exactly.
- **CHANGELOG:**
  - Every released version section has a line `Database: …`, listing the migrations it adds, or "No database change."
  - The release body is that section.
  - A missing section fails the release.
- **The workflow never deletes or overwrites a release.** Drafts only; the owner publishes.
- **Gate before every commit:** `npm test && npm run lint && npm run typecheck`, `cargo test --workspace`, `cargo clippy --workspace --all-targets -- -D warnings`, `cargo fmt --all --check`.

## Review Focus

1. **The fixture is genuinely from v0.2.0.** It is made by v0.2.0's own migrations, not by today's `apply_until`. Its `PRAGMA user_version` equals v0.2.0's `LATEST_VERSION` (3). Owner: Task 1, `fixture_is_from_release_0_2_0`.
2. **Nothing is lost.** Every field the manifest lists is compared after the upgrade: title, content JSON, colour, archived/trashed state, window x/y/w/h/visible/always-on-top/collapsed, and settings. Owner: Task 1, `upgrade_from_release_0_2_0_keeps_everything`.
3. **A too-new database stays untouched.** The file's bytes are unchanged, no backup is written, and the new message is shown. Owner: Task 2, `newer_database_message_and_untouched`.
4. **The workflow rejects bad tags.** It refuses a tag that isn't on `main`, a version mismatch, or a missing CHANGELOG section. Owner: Task 3. The checks are written as small scripts in `scripts/release/` and tested locally with sample inputs.
5. **Rollback steps work.** `docs/upgrading.md`'s commands are run on scratch data: install the previous release's binary, put back the pre-migration copy, and the notes open. Owner: Task 4 (controller real-app run).

---

### Task 1: Fixture from v0.2.0 and the upgrade test

**Files:**
- `scripts/release/make-fixture.sh` (new)
- `crates/desknotes-core/tests/fixtures/release-0.2.0.db` (new, binary)
- `crates/desknotes-core/tests/fixtures/release-0.2.0.json` (new manifest)
- `crates/desknotes-core/tests/release_upgrade.rs` (new)

**`make-fixture.sh TAG` behaviour:**
1. Creates a temporary `git worktree` at TAG.
2. Writes a tiny example program into it, outside the tracked files, that uses that tag's `desknotes-core` public API to create the sample data in a fresh database. It covers every kind of data that version knew, using only the API available at that tag:
   - three active notes with rich content (heading, list, checklist, link), different colours, window geometry, one always-on-top and one collapsed;
   - one archived note and one trashed note;
   - the settings that exist at that tag.
3. Runs the example. Copies `desknotes.db` and a JSON manifest of the expected values into `crates/desknotes-core/tests/fixtures/`.
4. Removes the worktree.

The script is deterministic: fixed ids and timestamps where the API allows them. Where it doesn't, the manifest records whatever was written.

**Steps:**
- [ ] Write the failing test `release_upgrade.rs`.
  - `fixture_is_from_release_0_2_0`: open the fixture file read-only with plain rusqlite. Assert `user_version == 3`.
  - `upgrade_from_release_0_2_0_keeps_everything`:
    - copy the fixture to a temp dir and run `Database::open`;
    - for every manifest note, compare title, content, colour, state and window;
    - compare the settings;
    - assert `schema_version() == LATEST_VERSION`;
    - assert exactly one `pre-migration-v3-*` file exists and is byte-identical to the fixture.
- [ ] Run it. Expect FAIL: no fixture yet.
- [ ] Write the script and run `scripts/release/make-fixture.sh v0.2.0`. Commit its output.
- [ ] Run it again. Expect PASS.
- [ ] Commit: `test(core): upgrade from a real v0.2.0 database keeps every note`.

### Task 2: A plain message for a database from a newer version

**Files:** `src-tauri/src/state.rs`, and where start-up errors are shown, if that needs a change.

**Behaviour:** in `AppState::open`, a `CoreError::SchemaTooNew` maps to the verbatim message. Other errors keep today's text. Put the mapping in a small pure function `startup_message(&CoreError) -> String` and test it.

**Steps:**
- [ ] Write the failing tests:
  - `newer_database_message`, covering the mapping;
  - `newer_database_message_and_untouched`: a core-level test that writes a file with `user_version = LATEST + 1`, then checks the bytes are unchanged after `Database::open` fails and no backups folder was created. Extend the existing test if it already does part of this.
- [ ] Run them. Expect FAIL.
- [ ] Implement.
- [ ] Run them, then the gate.
- [ ] Commit: `feat: plain message when notes come from a newer DeskNotes`.

### Task 3: Release workflow safety rules

**Files:**
- `.github/workflows/release.yml`
- `scripts/release/check-tag.sh` (new): version match, beta detection, on-`main` check
- `scripts/release/changelog-section.sh` (new): extracts a version section, fails if it is missing or has no `Database:` line
- `CHANGELOG.md`: add `Database: …` lines to the 0.1.0 and 0.2.0 sections and the Unreleased section, using the real migrations from git history

**Workflow changes:**
- In the build job, before building:
  - run `check-tag.sh`;
  - `git fetch origin main` and `git merge-base --is-ancestor $GITHUB_SHA origin/main`;
  - run the full gate: lint, typecheck, `cargo fmt --check`, clippy and tests.
- In the release job:
  - write the body with `changelog-section.sh`;
  - pass `--prerelease` for `-beta.N` tags;
  - use `--notes-file` instead of `--generate-notes`.
- Add `actions/attest-build-provenance` for `dist-packages/*`, with `permissions: id-token: write, attestations: write`, pinned to a released major version.
- Keep `--draft`. Nothing deletes or overwrites releases.

**Steps:**
- [ ] Write a small bash test harness, `scripts/release/test.sh`, that runs both scripts against sample inputs:
  - matching and mismatched versions;
  - a beta tag;
  - a missing section;
  - a section without a Database line.
- [ ] Run it. Expect FAIL.
- [ ] Implement the scripts and the workflow.
- [ ] Run it. Expect PASS.
- [ ] Run `actionlint` on the workflow if it is available, otherwise a YAML parse. Say which.
- [ ] Commit: `ci(release): main-only tags, full gate, beta pre-releases, CHANGELOG notes, provenance`.

### Task 4: Documents and the rollback check

**Files:**
- `docs/releasing.md` (new)
- `docs/upgrading.md` (new)
- `README.md` (link)
- `docs/testing/m5-safe-updates-verification.md` (controller)
- `CHANGELOG.md` Unreleased entry

**Steps:**
- [ ] Write both documents with exact commands and paths:
  - the data folder `~/.local/share/io.github.krusselalex.desknotes/`;
  - the `backups/pre-migration-v{N}-{ms}.db` files;
  - `sudo apt install --reinstall ./DeskNotes_X_amd64.deb`;
  - the AppImage, including `chmod +x`;
  - rollback: quit from the tray, install the previous release, copy the pre-migration file over `desknotes.db` after moving the current one aside (never delete it), and start.
- [ ] Controller: run the rollback steps on scratch data with the real v0.2.0 binary from the GitHub release and today's build. Record the result.
- [ ] Commit: `docs: releasing checklist, upgrading and rollback`.
