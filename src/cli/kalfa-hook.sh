#!/usr/bin/env bash
# kalfa-hook <harness> <event>: the fast path in front of `kalfa hook`. A hook
# fires on every tool call, so Node starts only when a handler can run here:
# the Core handles the event, or the repository's event table lists it and the
# payload matches the table's filter for it, if it has one, or the session's
# context is at least the table's size for it (read by the Adapter's probe).
# With a project file and no table yet, Node runs (and session.start writes
# the table).
set -u
harness=${1:-}
event=${2:-}
input=$(cat)
here=$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")
# Not `printf | exec node`: in a pipeline exec runs in a subshell, and the
# shim would go on and could start Node a second time.
run() { exec "${KALFA_NODE:-node}" "$here/kalfa.mjs" hook "$@" < <(printf '%s' "$input"); }

case " @CORE_EVENTS@ " in *" $event "*) run "$@" ;; esac
root=$PWD
until [[ -e $root/.git ]]; do
	[[ $root == / ]] && exit 0
	root=$(dirname "$root")
done
[[ -f $root/kalfa.yaml ]] || exit 0
table=$root/.kalfa/events
[[ -f $table && $table -nt $root/kalfa.yaml ]] || run "$@"
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
