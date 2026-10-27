#!/usr/bin/env bash
# Records real Claude Code hook payloads for the Adapter contract tests.
#   scripts/record-claude-fixtures.sh            one `claude -p` run (costs a few cents)
#   scripts/record-claude-fixtures.sh --from DIR scrub payloads recorded earlier
# A scratch repository gets recorder-only hooks; the payloads are scrubbed of
# home paths and ids (the repository is public) and written to
# test/fixtures/claude/<version>/. Commit them, and `git diff` shows what a new
# Claude Code version changed.
set -euo pipefail

kalfa=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
version=$(claude --version | awk '{print $1}')
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

if [[ ${1:-} == --from ]]; then
	out=$2
	repo=$(jq -r .cwd "$(ls "$out"/*.json | head -n 1)")
else
	out=$work/out repo=$work/repo
	mkdir -p "$out" "$repo/.claude"
	git -C "$repo" init -q
	record() { printf '[{"type":"command","command":"cat > %s/$(date +%%s%%N)-%s.json"}]' "$out" "$1"; }
	cat > "$repo/.claude/settings.json" <<JSON
{"hooks": {
  "SessionStart": [{"hooks": $(record SessionStart)}],
  "UserPromptSubmit": [{"hooks": $(record UserPromptSubmit)}],
  "PreToolUse": [{"matcher": "Bash", "hooks": $(record PreToolUse)}],
  "PostToolUse": [{"matcher": "Bash", "hooks": $(record PostToolUse)}]
}}
JSON
	(cd "$repo" && claude -p 'Run the shell command `echo hi` with the Bash tool, then reply with the single word: done.' \
		--model haiku --allowedTools 'Bash(echo hi)' < /dev/null > /dev/null)
fi

dest=$kalfa/test/fixtures/claude/$version
mkdir -p "$dest"
for hook in SessionStart UserPromptSubmit PreToolUse PostToolUse; do
	file=$(ls "$out"/*-"$hook".json | head -n 1)
	jq --arg home "$HOME" --arg repo "$repo" '
		def literal($from; $to): split($from) | join($to);
		walk(if type == "string" then literal($repo; "/work/repo") | literal($home; "/home/operator") else . end)
		| .session_id = "00000000-0000-4000-8000-000000000000"
		| .transcript_path = "/home/operator/.claude/projects/-work-repo/00000000-0000-4000-8000-000000000000.jsonl"
		| if has("prompt_id") then .prompt_id = "00000000-0000-4000-8000-000000000001" else . end
		| if has("tool_use_id") then .tool_use_id = "toolu_fixture" else . end
	' "$file" > "$dest/$hook.json"
done
echo "recorded Claude Code $version payloads in $dest"
