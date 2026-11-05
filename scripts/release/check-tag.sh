#!/usr/bin/env bash
# Safety checks for a release tag, run by the release workflow before anything is built.
#
#   scripts/release/check-tag.sh TAG CONF MAIN_REF
#
#   TAG       the tag being released, for example v0.3.0 or v0.3.0-beta.1
#   CONF      path to src-tauri/tauri.conf.json. The repository root is taken to be the
#             folder above the one holding it, where package.json and Cargo.toml are read.
#   MAIN_REF  the ref the commit must be part of, for example origin/main
#
# It refuses (non-zero exit, a message on stderr, nothing on stdout) when
#   - the tag is not exactly vX.Y.Z or vX.Y.Z-beta.N (no -rc, no extra text);
#   - the tag minus the leading "v" is not exactly the "version" in CONF, in
#     package.json (".version") or in Cargo.toml (version under [workspace.package]);
#   - the commit being built (HEAD of the current repository) is not an ancestor of
#     MAIN_REF, so only code that has been merged to main can be released.
# When all checks pass it prints one line, prerelease=true (a -beta.N tag) or
# prerelease=false, which the workflow appends to $GITHUB_OUTPUT.
#
# Needs: bash, jq, awk, git. The checkout must have full history (fetch-depth: 0) and
# MAIN_REF must be fetched, or the on-main check cannot work and the script refuses.

set -euo pipefail

if [[ $# -ne 3 ]]; then
  echo "usage: $0 TAG CONF MAIN_REF   (for example: $0 v0.3.0 src-tauri/tauri.conf.json origin/main)" >&2
  exit 2
fi
TAG="$1"
CONF="$2"
MAIN_REF="$3"

TAG_RE='^v[0-9]+\.[0-9]+\.[0-9]+(-beta\.[0-9]+)?$'
if [[ ! "$TAG" =~ $TAG_RE ]]; then
  echo "Tag '$TAG' is not an accepted tag. Use vX.Y.Z for a release or vX.Y.Z-beta.N for a beta (for example v0.3.0 or v0.3.0-beta.1)." >&2
  exit 1
fi

if [[ ! -r "$CONF" ]]; then
  echo "cannot read $CONF" >&2
  exit 1
fi
VERSION="$(jq -er .version "$CONF")" || { echo "cannot read a version from $CONF" >&2; exit 1; }
if [[ "v$VERSION" != "$TAG" ]]; then
  echo "Tag $TAG does not match version $VERSION in $CONF. Change one so they are exactly the same." >&2
  exit 1
fi

# The other two version files live at the repository root, above src-tauri/.
REPO_ROOT="$(dirname "$CONF")/.."
PKG="$REPO_ROOT/package.json"
CARGO="$REPO_ROOT/Cargo.toml"

if [[ ! -r "$PKG" ]]; then
  echo "cannot read $PKG" >&2
  exit 1
fi
PKG_VERSION="$(jq -er .version "$PKG")" || { echo "cannot read a version from $PKG" >&2; exit 1; }
if [[ "v$PKG_VERSION" != "$TAG" ]]; then
  echo "Tag $TAG does not match version $PKG_VERSION in $PKG. Change one so they are exactly the same." >&2
  exit 1
fi

if [[ ! -r "$CARGO" ]]; then
  echo "cannot read $CARGO" >&2
  exit 1
fi
# The first `version = "..."` line inside the [workspace.package] table.
CARGO_VERSION="$(awk '
  /^[[:space:]]*\[/ { in_table = ($0 ~ /^[[:space:]]*\[workspace\.package\][[:space:]]*(#.*)?$/); next }
  in_table && /^[[:space:]]*version[[:space:]]*=/ {
    if (match($0, /"[^"]*"/)) { print substr($0, RSTART + 1, RLENGTH - 2); exit }
  }
' "$CARGO")"
if [[ -z "$CARGO_VERSION" ]]; then
  echo "cannot read a version under [workspace.package] in $CARGO" >&2
  exit 1
fi
if [[ "v$CARGO_VERSION" != "$TAG" ]]; then
  echo "Tag $TAG does not match version $CARGO_VERSION in $CARGO. Change one so they are exactly the same." >&2
  exit 1
fi

if ! git merge-base --is-ancestor HEAD "$MAIN_REF" 2>/dev/null; then
  echo "This commit is not on main ($MAIN_REF). Merge the work into main first, then tag the commit on main." >&2
  exit 1
fi

if [[ "$TAG" == *-beta.* ]]; then
  echo "prerelease=true"
else
  echo "prerelease=false"
fi
