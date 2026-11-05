#!/usr/bin/env bash
# Print one version's section of CHANGELOG.md; this becomes the release body.
#
#   scripts/release/changelog-section.sh VERSION FILE
#
#   VERSION  for example 0.3.0, or 0.3.0-beta.2 (a beta previews its release, so any
#            -beta.N is dropped and the 0.3.0 section is used)
#   FILE     the changelog, for example CHANGELOG.md
#
# The section is the lines under the "## [VERSION]" heading up to the next "## "
# heading (or the end of the file), without the heading and without blank lines at the
# start or end. It fails (non-zero exit, message on stderr, nothing on stdout) when
#   - there is no "## [VERSION]" heading, or
#   - the section has no line that starts with "Database:" (every release must say
#     what it does to the database, or "Database: No database change.").

set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "usage: $0 VERSION FILE   (for example: $0 0.3.0 CHANGELOG.md)" >&2
  exit 2
fi
VERSION="${1%%-beta.[0-9]*}"
FILE="$2"

if [[ ! -r "$FILE" ]]; then
  echo "cannot read $FILE" >&2
  exit 1
fi

# The version goes in through the environment so awk never interprets it. awk exits
# with 3 when the heading is not there.
rc=0
SECTION="$(CL_VERSION="$VERSION" awk '
  BEGIN { prefix = "## [" ENVIRON["CL_VERSION"] "]" }
  found && /^## / { exit }
  found { lines[++n] = $0; next }
  index($0, prefix) == 1 { found = 1 }
  END {
    if (!found) exit 3
    first = 1; while (first <= n && lines[first] ~ /^[[:space:]]*$/) first++
    last = n;  while (last >= first && lines[last] ~ /^[[:space:]]*$/) last--
    for (i = first; i <= last; i++) print lines[i]
  }
' "$FILE")" || rc=$?

if [[ "$rc" -ne 0 ]]; then
  echo "no section for $VERSION in $FILE (looked for a heading starting '## [$VERSION]')" >&2
  exit 1
fi
if ! grep -q '^Database:' <<<"$SECTION"; then
  echo "the $VERSION section in $FILE has no line starting 'Database:'. Add one (or 'Database: No database change.')." >&2
  exit 1
fi
printf '%s\n' "$SECTION"
