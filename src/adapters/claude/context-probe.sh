#!/usr/bin/env bash
# The Claude Code context probe (see kalfa-hook): prints the context the
# session's last request sent, read from the tail of its transcript, so the
# shim can leave Node asleep for a small session. Prints 0 for a subagent (it
# has its own context and no Module acts on it) and for a payload without a
# transcript; prints nothing when it cannot tell (no jq, no request in the
# tail), and then Node decides.
input=$(cat)
command -v jq > /dev/null || exit 0
# A tab would collapse an empty agent_id; the unit separator does not.
IFS=$'\x1f' read -r agent transcript < <(jq -r '[.agent_id // "", .transcript_path // ""] | join("\u001f")' <<< "$input")
[[ -z $agent && -f $transcript ]] || { echo 0; exit 0; }
tail -c 524288 "$transcript" | grep -F '"usage"' |
	jq -R 'fromjson? | select(.type == "assistant" and (.isSidechain | not) and .message.usage != null)
		| .message.usage | (.input_tokens // 0) + (.cache_creation_input_tokens // 0) + (.cache_read_input_tokens // 0)
		| select(. > 0)' | tail -n 1
