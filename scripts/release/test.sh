#!/usr/bin/env bash
# Tests for the release safety scripts (check-tag.sh and changelog-section.sh).
#
#   bash scripts/release/test.sh
#
# Uses no network. Everything it creates lives under one `mktemp -d` directory that is
# removed on exit; the repository it runs in is never changed. The on-main check is
# proven in a throwaway git repository made under that directory.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
CHECK_TAG="$HERE/check-tag.sh"
SECTION="$HERE/changelog-section.sh"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

pass=0
fail=0
ok()  { pass=$((pass + 1)); echo "ok   - $1"; }
bad() { fail=$((fail + 1)); echo "FAIL - $1"; [[ -z "${2:-}" ]] || echo "       $2"; }

# expect_ok NAME EXPECTED_STDOUT_SUBSTRING CMD...   (exit 0, stdout has the text)
expect_ok() {
  local name="$1" want="$2"; shift 2
  local out
  if out="$("$@" 2>"$TMP/err")" && [[ "$out" == *"$want"* ]]; then ok "$name"
  else bad "$name" "wanted exit 0 with '$want'; got: $out $(cat "$TMP/err")"; fi
}
# expect_fail NAME EXPECTED_STDERR_SUBSTRING CMD...   (non-zero exit, stderr has the text, stdout empty)
expect_fail() {
  local name="$1" want="$2"; shift 2
  local out
  if out="$("$@" 2>"$TMP/err")"; then bad "$name" "wanted a failure but it succeeded: $out"
  elif [[ "$(cat "$TMP/err")" != *"$want"* ]]; then bad "$name" "wanted message '$want'; got: $(cat "$TMP/err")"
  elif [[ -n "$out" ]]; then bad "$name" "printed to stdout on failure: $out"
  else ok "$name"; fi
}

# --- sample inputs ------------------------------------------------------------------
conf() { printf '{ "productName": "DeskNotes", "version": "%s" }\n' "$1" > "$TMP/conf.json"; echo "$TMP/conf.json"; }

REPO="$TMP/repo"
git init -q -b main "$REPO"
git -C "$REPO" config user.email test@example.invalid
git -C "$REPO" config user.name Test
git -C "$REPO" config commit.gpgsign false
git -C "$REPO" commit -q --allow-empty -m one
git -C "$REPO" commit -q --allow-empty -m two
MAIN_SHA="$(git -C "$REPO" rev-parse HEAD)"
# A commit that only exists on a side branch (not an ancestor of main).
git -C "$REPO" checkout -q -b side
git -C "$REPO" commit -q --allow-empty -m side-only
SIDE_SHA="$(git -C "$REPO" rev-parse HEAD)"
git -C "$REPO" checkout -q main

in_repo() { ( cd "$REPO" && "$@" ); }

# --- check-tag.sh: version, tag form, prerelease flag --------------------------------
git -C "$REPO" checkout -q "$MAIN_SHA"
expect_ok   "matching plain tag is accepted, prerelease=false" "prerelease=false" \
  in_repo bash "$CHECK_TAG" v0.3.0 "$(conf 0.3.0)" main
expect_ok   "matching beta tag is accepted, prerelease=true" "prerelease=true" \
  in_repo bash "$CHECK_TAG" v0.3.0-beta.1 "$(conf 0.3.0-beta.1)" main
expect_ok   "beta tag with a two-digit counter" "prerelease=true" \
  in_repo bash "$CHECK_TAG" v1.12.3-beta.10 "$(conf 1.12.3-beta.10)" main
expect_fail "mismatched version is refused" "does not match" \
  in_repo bash "$CHECK_TAG" v0.3.0 "$(conf 0.2.0)" main
expect_fail "beta tag against the plain version is refused" "does not match" \
  in_repo bash "$CHECK_TAG" v0.3.0-beta.1 "$(conf 0.3.0)" main
expect_fail "plain tag against a beta version is refused" "does not match" \
  in_repo bash "$CHECK_TAG" v0.3.0 "$(conf 0.3.0-beta.1)" main
expect_fail "-rc tag form is refused" "not an accepted tag" \
  in_repo bash "$CHECK_TAG" v0.3.0-rc.1 "$(conf 0.3.0-rc.1)" main
expect_fail "tag without the v is refused" "not an accepted tag" \
  in_repo bash "$CHECK_TAG" 0.3.0 "$(conf 0.3.0)" main
expect_fail "two-part version is refused" "not an accepted tag" \
  in_repo bash "$CHECK_TAG" v0.3 "$(conf 0.3)" main
expect_fail "beta without a counter is refused" "not an accepted tag" \
  in_repo bash "$CHECK_TAG" v0.3.0-beta "$(conf 0.3.0-beta)" main
expect_fail "trailing text after the tag is refused" "not an accepted tag" \
  in_repo bash "$CHECK_TAG" "v0.3.0-beta.1.x" "$(conf 0.3.0-beta.1.x)" main
expect_fail "missing arguments print usage" "usage" \
  in_repo bash "$CHECK_TAG" v0.3.0
expect_fail "unreadable config is refused" "cannot read" \
  in_repo bash "$CHECK_TAG" v0.3.0 "$TMP/does-not-exist.json" main

# --- check-tag.sh: the commit must be on main ----------------------------------------
git -C "$REPO" checkout -q "$MAIN_SHA"
expect_ok   "commit on main is accepted" "prerelease=false" \
  in_repo bash "$CHECK_TAG" v0.3.0 "$(conf 0.3.0)" main
git -C "$REPO" checkout -q "$SIDE_SHA"
expect_fail "commit not on main is refused" "not on main" \
  in_repo bash "$CHECK_TAG" v0.3.0 "$(conf 0.3.0)" main
expect_fail "beta commit not on main is refused" "not on main" \
  in_repo bash "$CHECK_TAG" v0.3.0-beta.1 "$(conf 0.3.0-beta.1)" main
expect_fail "unknown main ref is refused" "not on main" \
  in_repo bash "$CHECK_TAG" v0.3.0 "$(conf 0.3.0)" no-such-ref
git -C "$REPO" checkout -q main

# --- changelog-section.sh ------------------------------------------------------------
CL="$TMP/CHANGELOG.md"
cat > "$CL" <<'MD'
# Changelog

## [Unreleased]

Database: migration 9 (next thing).

### Added
- Something not released yet.

## [0.3.0] — 2026-12-01 — Milestone 5

Database: migrations 4–7 (private notes); backup format 5. A copy is made before upgrading.

### Added
- Thing one.
- Thing two.

### Fixed
- A bug.

## [0.2.1] — 2026-11-20

### Fixed
- Forgot the Database line.

## [0.2.0] — 2026-11-02 — Milestone 2

Database: migration 3 (collapsed notes); backup format 1.

### Added
- Old thing.
MD

expect_ok   "section is printed" "- Thing two." bash "$SECTION" 0.3.0 "$CL"
expect_ok   "section includes its Database line" "Database: migrations 4–7" bash "$SECTION" 0.3.0 "$CL"
expect_ok   "section includes later subheadings" "### Fixed" bash "$SECTION" 0.3.0 "$CL"

rc=0
out="$(bash "$SECTION" 0.3.0 "$CL" 2>/dev/null)" || rc=$?
if [[ "$rc" -ne 0 ]]; then bad "section stops at the next version heading" "exit $rc"
elif [[ "$out" != *"- Thing two."* || "$out" != *"A bug."* ]]; then bad "section stops at the next version heading" "own text missing: $out"
elif [[ "$out" == *"Old thing"* || "$out" == *"Something not released"* || "$out" == *"Forgot the Database"* || "$out" == *"## ["* ]]; then
  bad "section stops at the next version heading" "other sections leaked: $out"
else ok "section stops at the next version heading"; fi

out="$(bash "$SECTION" 0.2.0 "$CL" || true)"
if [[ "$out" == *"Old thing"* ]]; then ok "last section runs to the end of the file"
else bad "last section runs to the end of the file" "$out"; fi

expect_ok   "a beta uses its base version's section" "- Thing two." bash "$SECTION" 0.3.0-beta.1 "$CL"
expect_ok   "a later beta uses the same section" "Database: migrations 4–7" bash "$SECTION" 0.3.0-beta.12 "$CL"
expect_fail "a missing section is refused" "no section for 9.9.9" bash "$SECTION" 9.9.9 "$CL"
expect_fail "a beta with no base section is refused" "no section for 9.9.9" bash "$SECTION" 9.9.9-beta.1 "$CL"
expect_fail "a section without a Database line is refused" "Database:" bash "$SECTION" 0.2.1 "$CL"
expect_fail "missing file is refused" "cannot read" bash "$SECTION" 0.3.0 "$TMP/nope.md"
expect_fail "missing arguments print usage" "usage" bash "$SECTION" 0.3.0
# 0.3 must not match 0.3.0 by prefix; dots are literal.
expect_fail "version is matched exactly, not by prefix" "no section for 0.3" bash "$SECTION" 0.3 "$CL"
expect_fail "dots are literal" "no section for 0x3x0" bash "$SECTION" 0x3x0 "$CL"

# Look-alike headings must not satisfy a request for 0.2.0.
cat > "$TMP/lookalike.md" <<'MD'
## [0.2.01] — 2026-01-01

Database: No database change.

## [10.2.0] — 2026-01-02

Database: No database change.
MD
expect_fail "look-alike headings (0.2.01, 10.2.0) do not satisfy 0.2.0" "no section for 0.2.0" bash "$SECTION" 0.2.0 "$TMP/lookalike.md"

# A Database line mentioned only inside prose must not count; it must start the line.
cat > "$TMP/inline.md" <<'MD'
## [1.0.0] — 2027-01-01

The Database: line is missing here, only mentioned in a sentence.
MD
expect_fail "Database: must start a line" "Database:" bash "$SECTION" 1.0.0 "$TMP/inline.md"

# The real CHANGELOG: every released section carries a Database line.
expect_ok   "real CHANGELOG, 0.2.0" "Database: migration 3" bash "$SECTION" 0.2.0 "$ROOT/CHANGELOG.md"
expect_ok   "real CHANGELOG, 0.1.0" "Database: migrations 1–2" bash "$SECTION" 0.1.0 "$ROOT/CHANGELOG.md"

echo
echo "$pass passed, $fail failed"
[[ "$fail" -eq 0 ]]
