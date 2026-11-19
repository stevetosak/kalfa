---
title: "Usage improvements: Resets at Section ends, a pre-push hook, Tasks across branches, candidates from the Section"
description: "Four changes from the usage analysis of the first month with kalfa: Auto mode resets at a Section end instead of a token count, the push rule moves to a git pre-push hook, a Task is found after a branch switch, and section close writes its Memory candidates."
type: plan
status: active
topics: [agents, tooling]
---

The first month with kalfa (2026-10-31 to 2026-11-19) was measured from the
session transcripts against the week before it. The average context fell
from 146k to 122k tokens and the requests above 150k from 39% to 21%;
commits per prompt rose from 0.29 to 0.38 and interrupts fell from 2.2 to
0.4 per 100 prompts, at a flat cost per day. The friction was in four
places, and each part of this Plan removes one.

- **Resets follow a token count, not the work.** Auto mode resets a session
  at the next Section close past the compact point, and past the compact
  point plus 50k it tells the agent to close a Section in the middle of a
  step. A large context is right while the work needs its details (UI
  iteration is the clear case); when the work moves to another subject, the
  old details only cost. The 26 measured Resets saved about $0.50 each, a
  third of what the meter's estimate showed, so their real value is that
  the Operator never has to compact by hand, not the money.
- **The push rule parses shell text.** shell-quote does not split a command
  line at a new line, so `git status` and `git push origin main` on two lines
  pass; a heredoc that holds `${…}` throws "Bad substitution" and the rule,
  which fails closed, refused 8 harmless commands. git itself knows what a
  push sends: a pre-push hook gets the remote refs.
- **A branch switch loses the Task.** A Task is found by the current branch
  only, so 17 `section close` calls failed with "no Task Record" after the
  agent moved to a second branch inside one Task.
- **Memory candidates cost a call each.** 348 memory writes, most of them
  one call per candidate right after a `section close` that already holds
  the same text in its Memory candidates part.

## 1. Auto mode resets at Section ends

**Done when:** inside a Herdr pane, with `auto: true` in the machine settings of the meter, a new session is in Auto mode without `/meter`; a Section close from 100k resets it unless the agent passes `--keep`, and below 100k nothing happens; `/meter on|off` ends Auto mode for that session; outside Herdr the meter reminds at the compact point as before; at a very large context the agent gets a note and nothing resets; the usage report shows each Reset's measured saving beside the estimate; local checks pass; proven once live.

- [ ] Setting `auto` of the meter (default false; machine settings or `kalfa.yaml`). The session state keeps `auto: false` too, so `/meter on|off` overrides the setting for one session; outside a Herdr pane the setting does nothing.
- [ ] Section close: in Auto mode, from `RESET_FROM` (100k) every close resets the session unless `--keep`; `--keep` replaces `--no-reset <requests left>` and is logged as a keep. `task close` still never resets.
- [ ] No token-count trigger in Auto mode: the compact-point notes go. From `LARGE_AT` (300k), and again every 100k, the agent gets one note: the size, and that a Section close resets the session if the work has moved on. Outside Auto mode the reminders stay as they are.
- [ ] Session start in Auto mode: one line that tells the agent to close a Section at each logical end, that the close resets the session, and when to pass `--keep`.
- [ ] The usage report measures each Reset from the cost per request of the old session's last 20 requests against the new session's, beside the carried-context estimate; the payback estimate leaves the notes.
- [ ] `auto: true` in this machine's settings; the meter skill and the Plan sessions text say what changed.
- [ ] Prove it live: one session in a Herdr pane reaches Auto mode from the setting, resets at a Section close past 100k, and keeps its context with `--keep`.

`RESET_FROM` and `LARGE_AT` are first values. A Reset writes a fresh start of
about 57k tokens, so below 100k it saves almost nothing; 300k is twice the
old compact point. Both are tuned from `resets.jsonl` and the transcripts,
not from estimates. The agent decides `--keep` by the work, not by a payback
count: the next work needs this session's details or it does not. What it
still needs after a Reset goes in Found and Next.

## 2. The push rule as a pre-push hook

**Done when:** in a repository where an agent session started, a push from the agent to a protected branch is refused by git's pre-push hook whatever the command looks like (one line, many lines, a heredoc, a script, an alias); the repository's own pre-push hook still runs after it; the shell rule only refuses `--no-verify` on a push and a change of `core.hooksPath`; the old false refusals (a heredoc with `${…}`) pass; local checks pass.

- [ ] The hook: a small script that reads the refs git hands it on stdin and refuses a remote ref on a protected branch; it then runs the hook that was there before (kept beside it), so nothing the repository had is lost.
- [ ] Install: the guardrails Module is a machine Module, so its `session.start` handler writes the hook into the repository's hooks folder (`core.hooksPath` when set, as in cloud-infra; else `.git/hooks`, shared by every worktree) when it is missing or old, and says so once. git 2.34 has no hooks from config, so the file is the only route.
- [ ] The hook judges only a push from an agent session: Claude Code sets `CLAUDECODE=1` in its shell. Not portable: each Adapter names its own marker. The Operator's own pushes pass.
- [ ] The shell rule shrinks to a text check: `push` with `--no-verify`, or `core.hooksPath` in a `git config` or `-c`. Tests for a two-line push, a heredoc with `${…}` and a push through a script.
- [ ] `kalfa doctor` reports a repository whose hook is missing or not kalfa's.

## 3. A Task across branches

**Done when:** after a branch switch inside a Task, `kalfa section close` without `--task` finds the Task when it is the only open one; with several open, the error lists them with the `--task` line for each; a `--task` call on a new branch adds the branch to the Task Record, and later calls on that branch find the Task; local checks pass.

- [ ] `taskId()`: the Task of the current branch, then the Task Record whose `branches:` holds the branch, then the only open Task; else an error that lists the open Tasks.
- [ ] A `--task` call on a branch the record does not hold adds it to `branches:`.
- [ ] The successor and the session brief find the Task the same way.

## 4. Memory candidates from the Section

**Done when:** `kalfa section close` writes each candidate of its Memory candidates part as a proposed record and prints the ids; a candidate that names an existing id is not written again; `none` with or without a reason writes nothing; the guidance tells the agent to commit and close the Section in one Bash call; local checks pass.

- [ ] One candidate per line in the part: a summary, an optional layer (`[personal]`, else project) and an optional body after it; `section close` writes them with the same code as `kalfa memory add --proposed`.
- [ ] A bare id of an existing record counts as a reference, not a new candidate (the form agents use today).
- [ ] `none (<reason>)` counts as no candidate (the open record candidates-none-with-reason).
- [ ] The core hint and the successor prompt: commit, `section close` and anything else at a Section end in one Bash call.
- [ ] Supersede the personal rule memory-candidates-written-proposed: candidates go in the Section; `kalfa memory add --proposed` stays for one found in the middle of a Section.

## Order

Part 1 first: the Operator asked for it directly, and every session pays for
it. Part 2 next, because its faults refuse work or let a push through. Parts
3 and 4 then, in either order.
