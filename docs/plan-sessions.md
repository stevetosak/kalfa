---
title: "Sessions: continuity across days and many parallel sessions"
description: "Idle checkpoints, a recap after days away, a board of all sessions with cleanup, workspace presets and an autonomous compaction mode."
type: plan
status: active
topics: [agents, tooling]
---

Work on many repositories at once leaves several agent sessions open per
repository, and after a few days away the last Task, the reasoning behind it
and the next step are hard to recover. This Plan closes those gaps in order of
cost: the smallest part rests on what the harness already does, the largest
needs new mechanics.

A spike on 2026-11-12 settled the ground. Claude Code keeps the main
conversation on a one-hour prompt cache within plan usage (five minutes on
usage credits, for subagents and for compaction), and it compacts an idle
session itself before that hour ends, from 200k tokens by default. Its
PreCompact hook steers the summary and its PostCompact hook receives it. An
outside process can type into a session through `herdr agent prompt`,
including `/compact` and `/clear`; a finished turn in an unfocused pane reads
as `done`, not `idle`, and `/clear` reports a stall although it clears.
Claude Code's own `/recap` covers the current session in one line, so the
recap below takes another name.

## 1. Idle checkpoint

The built-in idle compaction does the work; kalfa gives it the Task's focus
and keeps what it wrote.

**Done when:** a compaction in a session with an open Task carries the Task's goal, Decisions and Next into the summary, and the summary is the Task's Checkpoint afterwards, proven in a real session.

- [x] Claude Adapter: map PreCompact and PostCompact to Core events.
- [x] PreCompact prints the summary focus from the open Task Record (goal, Done when, Decisions, Next).
- [x] PostCompact saves `compact_summary` as the Task's Checkpoint, with its trigger and time, next to the Task Record.
- [x] Set `CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS` to 100k (the meter's GUARD_FROM, and the lowest Claude Code takes) through `kalfa install`, and report it in `kalfa doctor`.
- [ ] Prove it with a manual `/compact` in a scratch repo, then with one real idle compaction.

## 2. Recap after days away

**Done when:** `/where-was-i` in a repository with a closed or open Task shows the Plan part, the Task's goal, the Decisions of its last Sections, the last checkpoint, the commits since and the Next step, and a session start after N idle days shows it unasked.

- [x] `kalfa recap`: the Plan part, the last Task (goal, Done when, Sections, recent Decisions, Next), the last checkpoint, commits since the last Section, other open Tasks. No model call.
- [x] `/where-was-i` skill: reads `kalfa recap` and tells the line of thinking in a few sentences.
- [x] Session start shows the recap instead of the open Tasks when the repository has had no activity for N days (`recap.after-days` in the machine settings, default 2).
- [x] `kalfa section close` warns when a Section has no Decisions part.
- [x] Prove it in a real session: `/where-was-i`, and a session start after the idle days.

## 3. Board and cleanup

**Done when:** `kalfa board` lists every agent session across workspaces with its Task, state, context, idle time, cache state and Next, and a workspace whose Tasks are all closed is marked and closed only after the Operator's yes.

- [x] `kalfa board`: join `herdr agent list` with the Task Records and the meter state; one row per session.
- [x] Label each pane with its Task and Next step at session start and Section close.
- [x] Task close marks the workspace finished when all of its Tasks are closed.
- [x] `kalfa board --clean` lists the finished workspaces and closes them after one yes.
- [ ] Decide the visual board in a grill, after the CLI has been used.

## 4. Workspace presets

**Done when:** `kalfa space open <repo> --preset <name>` opens a workspace with the preset's tabs, and with `--task` a git worktree, a branch and a Task Record for that Task.

- [x] Decide the preset format, the worktree place and the Task Record path in a grill.
- [x] Private state in the main checkout: a worktree's Task Records, Checkpoints and session stamp go to the main checkout's `.kalfa/`; the event table and wake markers stay in each checkout, where the hook shim looks.
- [x] Preset format in the herdr Module's machine settings (never `kalfa.yaml`): `presets` of ordered tabs, each `agent: <adapter>` or `run: <command>` with one pane, a `default-preset`, and `space-dirs` for bare repository names.
- [x] `kalfa space open <repo> [--preset <name>]`: the Workspace labelled with the repository's folder name; a new one gets the preset's tabs and focus; an existing one is focused, and gets tabs only with an explicit `--preset`.
- [x] `--task <branch> "<goal>" --done-when "<check>" [--plan <path>]`: `git fetch`, a worktree in `<parent>/<repo>.worktrees/<task>` on a new branch from the remote default branch (or the existing branch), the Task Record, then the preset's tabs in the repository's Workspace, labelled with the Task id, the agent tab on the successor prompt. An existing Task needs only `--task`.

Worktree cleanup after a Task closes is a deferred item, not a step here.

## 5. Autonomous compaction

A per-session mode, never a project setting. A grill on 2026-11-13 settled it:
the reset is a Section close, `/clear` and continue, never a `/compact`,
because a Section close is a summary the agent writes with the whole context
for a few output tokens, and it stays in the Task Record. The payback point
starts as an estimate; the cost of each real reset is recorded so that the
thresholds can be tuned from measured data.

**Done when:** a session in auto mode passes the compact point, resets at a Section boundary without the Operator, and goes on with the Task; the cost and the saving of each reset are measured from the transcripts and shown in `kalfa meter usage`.

- [x] Decide the trigger, the skip rule, the mode's place and the cost record in a grill.
- [x] Auto mode: `/meter auto` (the Operator) and `kalfa meter auto` (the agent, only when the Operator asks for an autonomous run), kept in the per-session meter state; only inside Herdr.
- [x] The reset: in auto mode past the compact point, with the Task open, `kalfa section close` starts a detached waiter: the pane goes idle or done, `/clear`, a new session id (checked through Herdr, not the exit code), the meter state carried to it, `continue`.
- [x] The skip: the meter note and `section close` give the payback point; `section close --no-reset <requests left>` skips, and the skip is recorded with that estimate. `task close` never resets.
- [x] Past the compact point plus COMPACT_NOW_AFTER the meter tells the agent to close a Section now, with the in-flight state in Found and Next; auto mode never types `/compact`.
- [x] Each reset and skip goes to `resets.jsonl` in the machine cache; `kalfa meter usage` gets a Resets part: cost, saving so far, payback reached.
- [ ] Prove it in a real session: one autonomous run past the compact point.
- [ ] Supersede the compact-not-handoff memory rule for auto mode.
