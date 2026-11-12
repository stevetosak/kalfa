---
title: "Session context: every Loaded record in view at session start"
description: "Claude Code shows the model only a 2 KB preview of a long SessionStart context, so most of Standing memory does not load; fit the context to the harness or load it another way."
type: plan
status: active
topics: [memory, agents]
---

The Recap work of 2026-11-12 showed that Standing memory does not load as
ADR 0002 intends. Claude Code 2.1.322 saves a SessionStart `additionalContext`
above about 10 KB to a file and gives the model a 2 KB preview of it, with the
file's path. The session context of the kalfa repository was 18.9 KB on that
day: the Personal layer 11.3 KB (30 rules and the index lines), the project
layer 4.7 KB, and the open Plans, recall and deferred items 2.7 KB. Only the
first rules were in view; the rest, the Plans and the Tasks loaded only when
the model chose to read the file. A scratch session proved it: a Recap placed
after the memory block was out of view, and the model said so. The Recap now
goes first in the context, which hides the problem for one report but does not
solve it.

The memory budgets count rules and index bytes per layer and never the whole
report, so nothing warns when the total passes what the harness keeps. The fix
waits for its own Task: it touches the budgets that ADR 0002 set, and the way
the Loaded tier reaches the model is a design choice.

## 1. Measure the limit

**Done when:** the limit is known as a number, with how Claude Code counts it (per hook command or per event, characters or bytes) and what the model sees past it, proven with a scratch session.

- [x] Find the threshold with sized outputs from a scratch SessionStart hook.
- [x] Check whether two hook commands on SessionStart each get their own limit.
- [x] Check whether `@` imports in CLAUDE.md and the other context paths have a limit of their own.

## 2. Decide how the session context fits

**Done when:** a grill has chosen how the Loaded tier and the session report reach the model within the limit, and the choice is recorded in an amendment to ADR 0002.

- [x] Decide in a grill: one budget for the whole report, a split over several hook commands, the rules in a generated file that CLAUDE.md imports, or a mix.

## 3. Fit it and report it

**Done when:** in a real session on this machine the model sees every Loaded rule, the session report and the Recap without reading a file, and `kalfa doctor` warns when the session context passes the harness's limit.

- [ ] Apply the choice from part 2.
- [ ] The Claude Adapter knows the limit; `kalfa doctor` shows the session context size against it.
- [ ] Prove it with a scratch session: a rule at the end of the Loaded tier is quoted without a file read.
