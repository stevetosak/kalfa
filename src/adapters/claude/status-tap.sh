#!/usr/bin/env bash
# status-tap <status line command…>: the Claude Code status line wrapper.
# Saves the usage limits from the status line input where the Core reads them
# (src/core/usage-limits.ts), then hands the input on to the Operator's own
# status line command. Only the status line ever receives the limits. It must
# stay fast: it runs on every render.
input=$(cat)
file="${XDG_CACHE_HOME:-$HOME/.cache}/kalfa/usage-limits.json"
if [[ $input == *'"rate_limits"'* ]] && command -v jq > /dev/null; then
	mkdir -p "${file%/*}"
	jq -c '{savedAt: (now * 1000 | floor), limits: .rate_limits}' <<< "$input" > "$file.tmp" 2> /dev/null && mv "$file.tmp" "$file"
fi
(($#)) || exit 0
printf '%s' "$input" | "$@"
