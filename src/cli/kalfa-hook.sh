#!/usr/bin/env bash
# kalfa-hook <harness> <event>: the fast path in front of `kalfa hook`. A hook
# fires on every tool call, so Node starts only when a handler can run here:
# the Core handles the event, or the repository's event table lists it. With a
# project file and no table yet, Node runs (and session.start writes the table).
set -u
event=${2:-}
input=$(cat)
here=$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")
run() { printf '%s' "$input" | exec "${KALFA_NODE:-node}" "$here/kalfa.mjs" hook "$@"; }

case " @CORE_EVENTS@ " in *" $event "*) run "$@" ;; esac
root=$PWD
until [[ -e $root/.git ]]; do
	[[ $root == / ]] && exit 0
	root=$(dirname "$root")
done
[[ -f $root/kalfa.yaml ]] || exit 0
table=$root/.kalfa/events
[[ -f $table && $table -nt $root/kalfa.yaml ]] || run "$@"
grep -qxF -- "$event" "$table" && run "$@"
exit 0
