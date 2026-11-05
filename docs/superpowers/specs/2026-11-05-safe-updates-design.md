# Safe updates — design (Milestone 5, DES-22)

Date: 2026-11-05 · Jira: DES-22 (parent DES-6)
Source: the owner's own requirements in DES-22.

**Owner decision (2026-11-05):** delivery is **manual .deb / AppImage from GitHub Releases**. People download new versions themselves. The app makes no network access and has no update check. Anything else marked **(my call)** below is my decision.

## 1. Intent

A new version must never break the app or lose notes. If something does go wrong, the way back must be known and easy: the previous version stays downloadable, and the database copy taken before the upgrade can be put back.

## 2. What already exists (verified in code)

- Versioned migrations, appended only.
- `Database::open` copies the database to `backups/pre-migration-v{N}-{time}.db` before any migration runs.
- A database from a newer version is refused and left untouched (`schema_too_new`, tested).
- `release.yml`:
  - checks the tag against `tauri.conf.json`;
  - runs `npm test` and `cargo test`;
  - builds the .deb and AppImage with `SHA256SUMS`;
  - creates a **draft** GitHub release, so nothing is public until the owner publishes it.

## 3. Goals

### 3.1 Upgrade test with a real database from the previous release
- A database file made by the **v0.2.0 release's own code** is committed as a test fixture. It holds:
  - active, archived and trashed notes;
  - rich content and colours;
  - window geometry, always-on-top and collapsed;
  - app settings.

  Next to it sits a small manifest of what it holds.
- A core test opens a copy with today's `Database::open` and checks:
  - every note survives with the same title, content, colour, state and window;
  - the settings survive;
  - the schema reaches the latest version;
  - exactly one pre-migration copy was written.
- The fixture is made by a script that builds the core **at the release tag** (in a temporary git worktree) and writes known sample data. Each future release adds its own fixture in the same way (my call). This is release step 5 in `docs/releasing.md`.

### 3.2 A clear message for a database from a newer version
- Today start-up shows "The notes database could not be opened: …" with a technical error. It becomes: "Your notes were saved by a newer version of DeskNotes. Install that version (or newer) to open them; nothing was changed." (my call; no design exists). The text goes wherever start-up errors already appear.
- Nothing is written to the database or the backups folder in that case. This is already true and tested; the new message gets its own test.

### 3.3 Release safety rules, enforced by the workflow
- **A tag must point to a commit on `main`.** The workflow refuses otherwise (my call: it stops a release from an unmerged branch).
- **The full gate runs before building:**
  - `npm test`, `npm run lint`, `npm run typecheck`;
  - `cargo fmt --check`, `cargo clippy -D warnings`, `cargo test --workspace`.

  This is the same as CI, which today checks more than the release job does.
- **Beta first.** A tag like `v0.3.0-beta.1` makes a **pre-release** draft. A plain `v0.3.0` makes a normal draft. The version check accepts the beta suffix only if `tauri.conf.json` carries the same version (my call: Tauri accepts semver pre-release versions; the builder confirms the .deb and AppImage build with them).
- **Old releases stay.** The workflow never deletes or overwrites releases. `docs/releasing.md` says older releases must stay published.
- **Release notes list database changes.**
  - The release body is the CHANGELOG section for that version, not GitHub's generated notes.
  - Every CHANGELOG version section gets a "Database" line, listing the migrations it adds and the backup format, or "No database change."
  - The workflow refuses to release if that version's section is missing (my call).
- **Provenance.** The packages get a GitHub build-provenance attestation, made by GitHub's own free signing with no key to keep (my call). Anyone can check where a file came from with `gh attestation verify`. `SHA256SUMS` stays.

### 3.4 Documents
- `docs/releasing.md`: the owner's checklist.
  1. CI green on `main`.
  2. Bump the version.
  3. CHANGELOG section with its Database line.
  4. Add the previous release's fixture.
  5. Tag a beta, test it in the real app (the existing verify skill), then tag the release.
  6. Publish the draft.
  7. Never delete old releases.
- `docs/upgrading.md`: for users.
  - How to install a new .deb or AppImage.
  - That a copy of the notes is made before every upgrade, and where it is.
  - **How to roll back:** quit DeskNotes, install the previous release, and replace `desknotes.db` with the `pre-migration-…` copy. Exact paths and commands are given.
  - Linked from the README.

## 4. Non-goals

- Any network access or update check in the app (owner decision).
- Flathub, an apt repository, auto-update.
- Cutting the 0.3.0 release itself. Bumping the version, tagging and publishing stay the owner's decision. This work only makes it safe.
- Built-in rollback in the app, such as a "restore pre-upgrade copy" button. Documented steps are enough for now (my call).

## 5. Constraints

- No network in the app. The workflow may use GitHub only at release time.
- Never edit shipped migrations. The fixture test must not need any change to the core's migrations.
- The fixture file is small, a few tens of KB, and is binary SQLite. That is acceptable in the repo (my call).
