---
name: recall
description: Searches what kalfa remembers (Memory records, Task Records, project docs, old archives) and does the Cleanup that takes a closed Task's findings into Long-term memory. Use before work that may repeat an old decision or fault, when the Operator asks what was decided or found before, when a recall hit on the first prompt looks relevant, or at Task close when kalfa gives the Cleanup steps.
---

# Recall memory

**Search before you guess.** `kalfa memory search "<words>"` searches the
Memory records, the Task Records, the tracked Markdown of the repository and
the old archives. Use the words a page would use: names of tools, commands,
files and errors. Read the hit at its reference before you rely on it; a hit
is a pointer, not a proof. Hits come in tiers: the Memory records, the docs and
the open deferred items; then the Task Records in the repository; then the
closed records, the archived Task Records and the old archives; the most recently used first in each. A weak match comes
after every strong one, whatever its tier. kalfa searches for you once: the
first prompt of a session brings the relevant hits for the prompt and the
branch's Task. After that, search yourself.

**The Root Hub is the map.** At session start each layer that has a Root Hub
(the Hub `root`) loads it in place of its index lines. Follow a link `[[id]]`
with `kalfa memory show <id>` (`[[personal:id]]` with `--layer personal`); add
`--depth 2` when the summaries of the linked records are not enough.

**What you find yourself goes in the Remember part; the Cleanup writes it.**
Put it in the **Remember:** part of the Section, one bullet per finding; the
old names Memory candidates and Lesson candidates still work. In a session
without a Task, write the finding at once with `kalfa memory add`, linked as
the Cleanup links one. What the Operator states goes straight in: a rule with
`kalfa rule add` (into its layer's Rule pack), anything else with `kalfa
memory add`.

**At Task close you do the Cleanup.** kalfa copies the Task Record into the
Memory home and gives the steps: each finding of the Remember parts and the
commands for it. Check each finding against the later Sections, which may
correct it; search for its subject; then confirm, supersede or add its record
(the Task as its source), or add a rule with `kalfa rule add`. Link it to the
related records and into the Hub of its subject. When a layer is over its
budget, the steps also list its likely duplicates and its open items: merge
the duplicates and close each item whose work you can show is done. You
decide; do not ask the Operator. Then mark the record with `kalfa task
reconciled --task <id>`. The steps also list up to three closed records that
missed their Cleanup, the oldest first: take their findings in the same way,
with their own Task as the source, and mark each one. A marked record stays
in the repository while its Plan is open, an open Task names it, or fewer than
five Active days follow its close; a later Task close then moves it with its
Checkpoints to the archive in the Memory home, where search still finds it.

**The lint only reports.** `kalfa memory lint` names stale, duplicate and
over-budget records, broken links, personal records that link into a
project, and a Root Hub over its limit or a root record that is not a Hub. Fix
one when you can prove the fix: confirm it with proof, supersede it, or merge
two.
