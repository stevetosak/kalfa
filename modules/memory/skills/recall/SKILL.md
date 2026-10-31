---
name: recall
description: Searches what kalfa remembers (Memory records, Task Records, project docs, old archives) and handles the Memory candidates in the inbox. Use before work that may repeat an old decision or fault, when the Operator asks what was decided or found before, when a recall hit at session start looks relevant, or at Task close when kalfa lists Memory candidates.
---

# Recall memory

**Search before you guess.** `kalfa memory search "<words>"` searches the
Memory records, the Task Records, the tracked Markdown of the repository and
the old archives. Use the words a page would use: names of tools, commands,
files and errors. Read the hit at its reference before you rely on it; a hit
is a pointer, not a proof.

**What you find yourself is a candidate, never a record.** Put it in the
**Memory candidates:** part of the Section, one bullet per candidate. Only
what the Operator states goes straight in with `kalfa memory add`.

**At Task close** kalfa copies the Task Record into the Memory home, puts each
candidate into the inbox and asks you to put ONE question to the Operator:
each candidate with the type (rule, fact, decision, open), the layer
(personal, project) and the one-line summary you propose. Then, per answer:

- `kalfa memory inbox accept <id> --type <type> --layer <layer> --summary "<one line>"`
  (a body on stdin when the summary does not say it all)
- `kalfa memory inbox reject <id> "<reason>"`

A candidate the Operator does not answer stays in the inbox; session start
says how many wait. `kalfa memory inbox` lists them.

**The lint only reports.** `kalfa memory lint` names stale, broken, duplicate
and over-budget records. Fix one only with the Operator: confirm it with
proof, supersede it, or merge two.
