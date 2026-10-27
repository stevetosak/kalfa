#!/usr/bin/env bash
# The leak scan: kalfa is public and holds no personal content. The words it
# refuses come from KALFA_LEAK_PATTERN (an extended grep pattern, any case), so
# the list itself is not in the repository. It scans every file git tracks or
# would track, and reports a match by file and line only, because a public CI
# log must not repeat the word. Exit 0: clean, 1: a match, 2: no pattern.
set -euo pipefail
pattern=${KALFA_LEAK_PATTERN:-}
if [[ -z $pattern ]]; then
	echo "leak scan: KALFA_LEAK_PATTERN is not set" >&2
	exit 2
fi
cd "$(dirname "$0")/.."
matches=$(git ls-files -z --cached --others --exclude-standard | xargs -0 grep -niIE -- "$pattern" | cut -d: -f1,2 || true)
if [[ -n $matches ]]; then
	printf '%s\n' "$matches"
	echo "leak scan: personal content in the lines above" >&2
	exit 1
fi
echo "leak scan: clean"
