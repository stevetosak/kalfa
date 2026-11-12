---
name: where-was-i
description: Tells the Operator where the work of this repository stood - the Plan part, the last Task and its goal, why the work went this way (the Decisions of its last Sections), what changed since (commits) and the next step - from `kalfa recap` and the last Checkpoint. Use when the Operator types /where-was-i, comes back after days away, or asks where they were, what they were doing, or what the line of thinking was.
---

# Where was I

A read-only account of the last work. It changes nothing: no `task start`,
`task close`, `section close` or `memory` write.

## Steps

1. If the repository has no `kalfa.yaml`, say that it is not a kalfa project
   and stop.
2. Run `kalfa recap`. If the session start already gave the Recap, use that
   one. If the Operator names a Task, run `kalfa recap --task <id>`.
3. If the Recap shows a **Last Checkpoint** that is newer than the record's
   last write, read that file. It is the harness's summary of the session
   at its last compaction: it can hold the work after the last Section
   (files changed, open questions).
4. Tell the line of thinking in a few sentences, in this order:
   - **Where:** the Plan and its part, and the Task's goal.
   - **Why:** the Decisions that explain the current state. Give the
     reason, not only the choice.
   - **Since:** what the commits after the last record write did. If there
     are none, say that nothing changed since.
   - **Next:** the Next step of the Task, as the record says it.
5. Then, in one line each, other open Tasks, if there are any.

## Rules

- Keep it short: a paragraph and a few lines, not the whole Recap.
- Keep ids, paths, commands and branch names exact.
- The record can be out of date (for example, a PR that it waits for is
  already merged). Say what the record says; if a commit since shows that
  the Next step is done, say that too.
- Do not start the Next step. End with the account, and let the Operator
  choose.
