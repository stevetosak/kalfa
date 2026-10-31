#!/usr/bin/env bash
# kalfa-hook <harness> <event>: the fast path in front of `kalfa hook`. A hook
# fires on every tool call, so Node starts only when a handler can run here:
# the Core handles the event, or the event table lists it and the payload
# matches the table's filter for it, if it has one, or the session's context is
# at least the table's size for it (read by the Adapter's probe).
# The table: in a repository with kalfa.yaml, its own (the machine's Modules
# and the project's); elsewhere the machine's, and none at all when the machine
# settings do not exist. A missing table, or one older than a file it is made
# from, starts Node, and Node writes it again.
set -u
harness=${1:-}
event=${2:-}
input=$(cat)
here=$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")
# Not `printf | exec node`: in a pipeline exec runs in a subshell, and the
# shim would go on and could start Node a second time.
run() { exec "${KALFA_NODE:-node}" "$here/kalfa.mjs" hook "$@" < <(printf '%s' "$input"); }

case " @CORE_EVENTS@ " in *" $event "*) run "$@" ;; esac
config=${XDG_CONFIG_HOME:-$HOME/.config}/kalfa/config.yaml
root=$PWD
until [[ -e $root/.git || $root == / ]]; do root=$(dirname "$root"); done
if [[ -e $root/.git && -f $root/kalfa.yaml ]]; then
	table=$root/.kalfa/events
	[[ $table -nt $root/kalfa.yaml ]] || run "$@"
else
	[[ -f $config ]] || exit 0
	table=${XDG_CACHE_HOME:-$HOME/.cache}/kalfa/events
fi
[[ ! -f $config || $table -nt $config ]] || run "$@"
# The probe prints the context size, 0 when no Module acts on this session
# (a subagent), or nothing when it cannot tell; then Node decides.
context_from() {
	local probe=$here/adapters/$harness/context-probe size
	[[ -x $probe ]] || return 0
	size=$("$probe" <<< "$input" 2> /dev/null)
	[[ -z $size ]] || ((size >= $1))
}
tab=$'\t'
while IFS= read -r line; do
	[[ $line == "$event" ]] && run "$@"
	[[ $line == "$event$tab"* ]] || continue
	rest=${line#*"$tab"}
	filter=${rest%%"$tab"*}
	[[ -n $filter && $input =~ $filter ]] && run "$@"
	[[ $rest == *"$tab"* ]] && context_from "${rest#*"$tab"}" && run "$@"
	exit 0
done < "$table"
exit 0
