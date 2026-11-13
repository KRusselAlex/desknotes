# Releasing DeskNotes

This is the owner's checklist. Nothing here is automatic except building and drafting:
tagging, testing and publishing are done by hand. For what users do with a release, see
[upgrading.md](upgrading.md).

The release workflow ([`.github/workflows/release.yml`](../.github/workflows/release.yml))
runs when a tag is pushed. It refuses the tag unless:

- the tag is exactly `vX.Y.Z` or `vX.Y.Z-beta.N` (nothing else, no `-rc`);
- the tag equals the version in `src-tauri/tauri.conf.json`, in `package.json` and in
  `Cargo.toml` (`[workspace.package]`), each with a `v` in front;
- the tagged commit is on `main`;
- `CHANGELOG.md` has a `## [X.Y.Z]` section with a line starting `Database:`. A beta uses
  the section of its base version (`v0.3.0-beta.2` reads `## [0.3.0]`).

Then it runs the full checks (release script tests, lint, types, frontend tests,
`cargo fmt`, clippy and `cargo test`), builds the `.deb` and AppImage, writes
`SHA256SUMS`, adds a provenance attestation and creates a **draft** release whose text is
the CHANGELOG section. A beta tag makes the draft a pre-release. The workflow never deletes
or overwrites a release. The checks are in [`scripts/release/`](../scripts/release/) and
tested by `bash scripts/release/test.sh`.

## Checklist

### 1. CI is green on `main`

Merge everything for the release first, then check:

```bash
gh run list --branch main --limit 3
```

### 2. Bump the version

Edit these three files by hand, to the same number:

| File | Where |
|---|---|
| `Cargo.toml` | `version` under `[workspace.package]` (both crates use `version.workspace = true`) |
| `package.json` | `"version"` |
| `src-tauri/tauri.conf.json` | `"version"` |

Then update the two lock files, which carry the version too:

```bash
npm install --package-lock-only
cargo update --workspace
```

`package-lock.json` changes in two places and `Cargo.lock` in two (`desknotes` and
`desknotes-core`); nothing else should change. Also update the version in the status line
at the top of `README.md`.

The tag must equal the version in `tauri.conf.json`, so the beta needs its own bump:
set `0.3.0-beta.1` (for example) before tagging the beta, merge it to `main`, and set
`0.3.0` and merge again before tagging the release.

The workflow also compares `package.json` and `Cargo.toml` with the tag, so all three files
must carry the same number or the run is refused.

### 3. CHANGELOG section with its Database line

In `CHANGELOG.md`, rename `## [Unreleased]` to `## [X.Y.Z] — YYYY-MM-DD — title` and add a
new empty `## [Unreleased]` above it. Do this before the first beta: a beta reads the
section of its base version. Update the date in the heading at the final release, and put
fixes made between betas in the `[X.Y.Z]` section. The section must have a `Database:` line that lists
the migrations the release adds and the backup format, or `Database: No database change.`
Check it the way the workflow does:

```bash
scripts/release/changelog-section.sh X.Y.Z CHANGELOG.md
```

It prints the text that becomes the release notes, or says what is missing.

### 4. Add the previous release's fixture

The upgrade test opens a real database written by the previous release's own code. For each
release, add the fixture of the release before it (for `0.3.0`, that is `0.2.0`; it is
already in the repository). Skip this step if
`crates/desknotes-core/tests/fixtures/release-<previous>.db` exists.

```bash
git fetch --tags
scripts/release/make-fixture.sh vX.Y.Z   # the previous release's tag
```

This writes `release-<version>.db` and `release-<version>.json` into
`crates/desknotes-core/tests/fixtures/`. Add a test for it next to
`crates/desknotes-core/tests/release_upgrade.rs` (copy it, change the file names, the
version and the schema number) and commit all three. Never regenerate a fixture that is
already committed.

**Each release needs its own fixture example.** `make-fixture.sh` writes sample data with a
small example program, and today that program only knows what v0.2.0 stored (notes, window
positions, collapsed state, the edit lock and three settings). The script refuses any other
tag, and the example also stops if the tag's schema version is not the one it was written
for. Before making the fixture of a new release, extend the example to write **every kind of
data that release added**, extend the manifest it writes, add the tag to `SUPPORTED_TAGS`,
and make the copied test compare all of it. For the fixture made at `v0.3.0` that means
private notes and labels, appearance, reminders and completed notes. A fixture without them
would let the test pass without guarding them.

### 5. Tag a beta, test it, then tag the release

From an up-to-date `main` with the beta version from step 2:

```bash
git switch main && git pull --ff-only
git tag vX.Y.Z-beta.1 && git push origin vX.Y.Z-beta.1
```

When the run is green, download the files from the draft pre-release and test them in the
real app on Ubuntu (the `desknotes-verify-ubuntu` skill, `scripts/verify/`). Include
upgrading from the previous release with real-looking notes and the rollback in
[upgrading.md](upgrading.md). Write what you did in `docs/testing/`. If something is wrong,
fix it on `main`, bump to the next beta and tag `-beta.2`.

When a beta is good, set the final version (step 2), merge, and tag the release:

```bash
git switch main && git pull --ff-only
git tag vX.Y.Z && git push origin vX.Y.Z
```

Note for beta testing: apt sorts `0.3.0-beta.1` after `0.3.0`, so installing the final
release over a beta, or going back to an older release, shows "will be DOWNGRADED". It is
expected and changes no data; confirm with `Y`.

### 6. Publish the draft

The previous release must already be published (not a draft) before a new release goes
public, because users roll back to it. (v0.2.0 was published on 2026-11-13.)

On the [releases page](https://github.com/KRusselAlex/desknotes/releases) open the draft,
read the notes and the file list (`.deb`, `.AppImage`, `SHA256SUMS`), and click
**Publish release**. Publishing is the only step that makes a release public.

### 7. Never delete old releases

Keep every published release and its files. Users roll back by installing an older release
(see [upgrading.md](upgrading.md)), so those files must stay. If a release is bad, publish
a fixed version and say so in its CHANGELOG section instead of removing the old one.
