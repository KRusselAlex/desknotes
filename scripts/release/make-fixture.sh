#!/usr/bin/env bash
# Make the upgrade-test fixture for a released version.
#
#   scripts/release/make-fixture.sh v0.2.0
#
# Builds desknotes-core AT THE RELEASE TAG in a temporary git worktree, runs a small
# example program there (written by this script, never added to the repository) that
# uses only that release's own public API to create sample data in a fresh database,
# and copies two files into crates/desknotes-core/tests/fixtures/:
#   release-<version>.db    a snapshot of the database the release's own code wrote
#                           (made with that release's backup_to, so it is a single file)
#   release-<version>.json  a manifest of what it holds (read back from the database)
#
# The only files changed in this checkout are those two outputs. The worktree and its
# build directory live under a temporary directory and are always removed. Note ids
# and timestamps come from the release's code (random UUIDs, the clock), so a re-run
# writes different values; the manifest records whatever was written. Run it once per
# release and commit the result (docs/releasing.md); the committed fixture is never
# regenerated for an old release.
#
# Needs: git, cargo, python3. Cargo reads the dependencies named in the tag's Cargo.lock (the
# local cargo cache, or crates.io on first use). The app itself is never involved.

set -euo pipefail

TAG="${1:-}"
if [[ -z "$TAG" ]]; then
  echo "usage: $0 TAG   (for example: $0 v0.2.0)" >&2
  exit 2
fi

if ! [[ "$TAG" =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9.]+)?$ ]]; then
  echo "error: '$TAG' is not a release tag like v0.2.0 or v0.3.0-beta.1" >&2
  exit 2
fi

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"
git rev-parse --verify --quiet "refs/tags/$TAG^{commit}" >/dev/null \
  || { echo "error: tag $TAG does not exist in this repository" >&2; exit 1; }

VERSION="${TAG#v}"
FIXTURES="$ROOT/crates/desknotes-core/tests/fixtures"
TMP="$(mktemp -d)"
WORKTREE="$TMP/worktree"

cleanup() {
  git -C "$ROOT" worktree remove --force "$WORKTREE" >/dev/null 2>&1 || true
  git -C "$ROOT" worktree prune >/dev/null 2>&1 || true
  rm -rf "$TMP"
}
trap cleanup EXIT

echo "==> worktree at $TAG"
git worktree add --detach "$WORKTREE" "$TAG" >/dev/null

echo "==> writing the example program (inside the worktree only)"
mkdir -p "$WORKTREE/crates/desknotes-core/examples"
cat > "$WORKTREE/crates/desknotes-core/examples/make_fixture.rs" <<'EXAMPLE'
//! Writes sample data with the release's own API. Usage: make_fixture <out-dir> <tag>
use std::path::Path;

use desknotes_core::db::LATEST_VERSION;
use desknotes_core::{Database, Note};
use serde_json::{Value, json};

fn text(t: &str) -> Value {
    json!({ "type": "text", "text": t })
}

fn marked(t: &str, marks: Value) -> Value {
    json!({ "type": "text", "text": t, "marks": marks })
}

fn para(children: Vec<Value>) -> Value {
    json!({ "type": "paragraph", "content": children })
}

fn heading(level: u32, t: &str) -> Value {
    json!({ "type": "heading", "attrs": { "level": level }, "content": [text(t)] })
}

fn item(t: &str) -> Value {
    json!({ "type": "listItem", "content": [para(vec![text(t)])] })
}

fn task(t: &str, checked: bool) -> Value {
    json!({
        "type": "taskItem",
        "attrs": { "checked": checked },
        "content": [para(vec![text(t)])]
    })
}

fn doc(blocks: Vec<Value>) -> String {
    json!({ "type": "doc", "content": blocks }).to_string()
}

fn manifest_note(note: &Note) -> Value {
    json!({
        "id": note.id,
        "title": note.title,
        "content_json": note.content.to_string(),
        "color": note.color,
        "edit_locked": note.edit_locked,
        "archived": note.archived_at.is_some(),
        "trashed": note.deleted_at.is_some(),
        "created_at": note.created_at,
        "updated_at": note.updated_at,
        "archived_at": note.archived_at,
        "deleted_at": note.deleted_at,
        "window": {
            "x": note.window.x,
            "y": note.window.y,
            "width": note.window.width,
            "height": note.window.height,
            "visible": note.window.visible,
            "always_on_top": note.window.always_on_top,
            "collapsed": note.window.collapsed,
        },
    })
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let out = Path::new(&args[1]);
    let tag = &args[2];
    std::fs::create_dir_all(out).unwrap();
    let work = out.join("work");
    let db_path = work.join("desknotes.db");
    let db = Database::open(&db_path, &work.join("backups")).unwrap();

    // 1. Active note: heading, bullet list, bold text; always on top.
    let shopping = db.create_note(Some("#fff4a3")).unwrap();
    db.save_content(
        &shopping.id,
        &doc(vec![
            heading(1, "Shopping list"),
            para(vec![text("For the weekend "), marked("only", json!([{ "type": "bold" }]))]),
            json!({ "type": "bulletList", "content": [item("Bread"), item("Oat milk"), item("Coffee")] }),
        ]),
    )
    .unwrap();
    db.set_window_geometry(&shopping.id, Some((120.0, 80.0)), 320.0, 300.0).unwrap();
    db.set_always_on_top(&shopping.id, true).unwrap();

    // 2. Active note: heading, checklist (one done), numbered list; collapsed.
    let project = db.create_note(Some("#cde8ff")).unwrap();
    db.save_content(
        &project.id,
        &doc(vec![
            heading(2, "Project checklist"),
            json!({ "type": "taskList", "content": [
                task("Write the plan", true),
                task("Review with the team", false),
                task("Ship it", false),
            ] }),
            json!({ "type": "orderedList", "attrs": { "start": 1 }, "content": [item("First"), item("Second")] }),
        ]),
    )
    .unwrap();
    db.set_window_geometry(&project.id, Some((480.0, 90.0)), 360.0, 340.0).unwrap();
    db.set_collapsed(&project.id, true).unwrap();

    // 3. Active note: link, quote, italic text; locked against edits (saved first).
    let reading = db.create_note(Some("#d4f5d0")).unwrap();
    db.save_content(
        &reading.id,
        &doc(vec![
            heading(3, "Reading"),
            para(vec![
                text("Docs: "),
                marked(
                    "example.org",
                    json!([{ "type": "link", "attrs": {
                        "href": "https://example.org/docs", "target": "_blank",
                        "rel": "noopener noreferrer nofollow", "class": null } }]),
                ),
                text(" and "),
                marked("a note to self", json!([{ "type": "italic" }])),
            ]),
            json!({ "type": "blockquote", "content": [para(vec![text("Write it down.")])] }),
        ]),
    )
    .unwrap();
    db.set_window_geometry(&reading.id, Some((200.0, 420.0)), 300.0, 260.0).unwrap();
    db.set_edit_locked(&reading.id, true).unwrap();

    // 4. Archived note (its window is hidden by archiving).
    let archived = db.create_note(Some("#ffd6e0")).unwrap();
    db.save_content(
        &archived.id,
        &doc(vec![heading(1, "Old idea"), para(vec![text("Kept for later.")])]),
    )
    .unwrap();
    db.set_window_geometry(&archived.id, Some((60.0, 500.0)), 280.0, 220.0).unwrap();
    db.set_archived(&archived.id, true).unwrap();

    // 5. Trashed note (recoverable; its window is hidden).
    let trashed = db.create_note(Some("#e6d9ff")).unwrap();
    db.save_content(
        &trashed.id,
        &doc(vec![heading(1, "Throw away"), para(vec![text("Not needed any more.")])]),
    )
    .unwrap();
    db.set_window_geometry(&trashed.id, Some((640.0, 500.0)), 260.0, 200.0).unwrap();
    db.trash_note(&trashed.id).unwrap();

    // Settings this release knows.
    db.set_new_note_color("#cde8ff").unwrap();
    db.set_min_note_size(220, 160).unwrap();
    db.set_hidden_by_hide_all(std::slice::from_ref(&shopping.id)).unwrap();

    // Read everything back through the release's own API for the manifest.
    let notes: Vec<Value> = [&shopping, &project, &reading, &archived, &trashed]
        .iter()
        .map(|n| manifest_note(&db.get_note(&n.id).unwrap()))
        .collect();
    let mut settings_map = serde_json::Map::new();
    for key in ["new_note_color", "min_note_size", "hidden_by_hide_all"] {
        let value = db.get_setting(key).unwrap().expect("setting was written");
        settings_map.insert(key.to_string(), Value::String(value));
    }
    let manifest = json!({
        "release": tag,
        "schema_version": db.schema_version().unwrap(),
        "notes": notes,
        "settings": settings_map,
    });
    assert_eq!(manifest["schema_version"], LATEST_VERSION);
    std::fs::write(
        out.join("manifest.json"),
        serde_json::to_string_pretty(&manifest).unwrap() + "\n",
    )
    .unwrap();

    // The fixture is the release's own consistent snapshot (`backup_to`, VACUUM INTO),
    // the same form the app writes for its pre-migration copies: one self-contained
    // file in rollback-journal mode, so tests can open it read-only and compare the
    // pre-migration copy of an upgrade with it (same schema and rows).
    db.backup_to(&out.join("desknotes.db")).unwrap();
}
EXAMPLE

echo "==> building and running it against $TAG's core"
OUT="$TMP/out"
(
  cd "$WORKTREE"
  CARGO_TARGET_DIR="$TMP/target" cargo run --quiet -p desknotes-core --example make_fixture -- "$OUT" "$TAG"
)

# The release's migrations must have produced the schema version it shipped with.
VERSION_IN_DB="$(python3 - "$OUT/desknotes.db" <<'PY'
import sqlite3, sys
print(sqlite3.connect("file:%s?mode=ro" % sys.argv[1], uri=True).execute("PRAGMA user_version").fetchone()[0])
PY
)"
echo "==> fixture schema version (PRAGMA user_version): $VERSION_IN_DB"

mkdir -p "$FIXTURES"
cp "$OUT/desknotes.db" "$FIXTURES/release-$VERSION.db"
cp "$OUT/manifest.json" "$FIXTURES/release-$VERSION.json"
echo "==> wrote:"
ls -l "$FIXTURES/release-$VERSION.db" "$FIXTURES/release-$VERSION.json"
