---
status: accepted
date: 2026-10-31
---

# Memory: Standing memory in the Core, Recall memory in a replaceable file-first Module

The old setup kept the agent's memory in a handful of hand-edited Markdown files
that the harness loaded natively in every session. They grew to about 45 KB,
loaded in full in every repository whatever its subject, had no history, and
recorded a superseded decision only by the word "SUPERSEDED" in its prose. The
Logs written for each pull request were meant to serve both the Operator and the
agent; in practice the Operator rarely read them, because of their volume. So
memory and human-facing documentation are separated: this ADR fixes the agent's
memory, and a later design decides the human `docs` Module.

**Memory does two jobs, and they get two owners.** Standing memory, the rules,
facts, decisions and open items that must be present wherever they apply, is
the Core's: it loads in every session whether any Module is on or not, so a
safety rule never depends on an experiment. Recall memory, which captures,
searches, promotes and checks knowledge on demand, belongs to a `memory` Module
that can be replaced. That is the point of the split: a trial memory system can
take the Module's place while the default stays as the fallback.

**The Core injects the private layers; Rule packs stay native.** The Personal
layer and the Project layer are injected at `session.start` by the Adapter,
which is the same in every harness and enforces the budget exactly on every
start, including after a compaction. The Rule packs of the Modules are public,
generic and stable, so `kalfa build` keeps writing them as native harness files,
where a harness can load them lazily by path. The cost is that a private rule
cannot be scoped to file paths; a rule that needs that belongs in a Rule pack.

**A Memory record is one file, and its layer is its scope.** Each record has a
type, a status, an optional `superseded-by`, a `confirmed` date and a one-line
summary. There are four types, and the type decides how much loads: a rule loads
in full, because it must be exact; a fact, a decision or an open item loads as
its summary line and id, and its body is read on demand. Active work is not
memory: the Plans and Task Records hold it, and the Core already reports them.
There is no scope field. A record that belongs to neither the Personal layer, nor
one repository, nor one Module's Rule pack is in the wrong place, and a small
personal Module carries a rule meant for some repositories only.

**All private memory lives in one Memory home outside every repository.** The
Personal layer and every Project layer sit under one private folder with its own
git history, committed by the CLI on each write. A project is keyed by its
`origin` URL, so its work trees and clones share one Project layer; a git-ignored
folder inside a work tree would be lost with the work tree, and a folder beside
a public repository is one `.gitignore` mistake away from being published. The
Task Record stays in the repository, because it belongs to one branch; at Task
close a copy goes into the Memory home.

**The agent writes through the CLI, and approval follows the source.** `kalfa
memory add`, `supersede` and `confirm` check the record, set its dates, write
the supersede link and refuse a write that takes a layer over its budget. What
the Operator states is written at once. What the agent finds is a Memory
candidate in the Task Record, put to the Operator in one question at Task close;
an unanswered candidate waits in the inbox, and `session.start` says how many
wait. Accepting candidates only from the Operator is the answer to the main
weakness of automatic memory, which extracts wrong or duplicate memories without
anyone noticing.

**Budgets count rules, and bytes for the rest.** How reliably a model follows
its instructions falls as their number grows, so the rules of a layer are
limited by count; the index lines cost context, so they are limited by bytes.
The values are settings, first set a little above the measured size of the
sorted memory. Over budget, the Core injects every rule, fills the rest by the
most recently confirmed, and prints a visible line; it never blocks a session,
because an empty session would lose its safety rules.

**Staleness is reported, never hidden.** A record is confirmed only when someone
checked it, with the proof written to its history. Each type has an age limit
(none for a decision, whose change is a supersede), and the lint reports records
past it together with broken links, budget overruns and likely duplicates. A
stale record still loads.

**Search is keyword search over everything curated, and starts at the session.**
The `memory` Module indexes the Memory home, the Task Records, the project's
documentation and the old archives with MiniSearch, a pure-JavaScript library
that fits kalfa's single bundle on every supported Node; the index is a cache
in the user's cache folder, built again when a source changes. At
`session.start` it searches with the open Task's goal and next step and injects
a few index lines; the agent searches on demand at any time. Searching on every
prompt is a setting, off by default, for a trial against this default.

## Considered options

- **mem0.** Built to personalise chat applications; it needs an LLM for every
  write, an embedding model and a vector store, it only adds memories so
  contradictions accumulate, and its published results come from its hosted
  platform. An independent memory-hallucination benchmark measured its
  extraction recall falling sharply on long histories.
- **agentmemory.** The closest fit: local, Node, usable without an API key. Not
  now, because it is pre-1.0 with a high rate of change, needs a daemon and its
  own runtime, adds its own hooks for the events kalfa owns, and records every
  tool's input and output into a store no one reviews. It is a good first trial
  of a replacement `memory` Module.
- **The harness's own automatic memory.** Plain Markdown, but bound to one
  harness, and a second write path beside kalfa's. kalfa turns it off at install.
- **Automatic decay**, as in the LLM Wiki pattern. It suits chat memory, where
  old means less relevant; here old often means rare but critical, and decay
  would hide exactly those rules.
- **Embeddings and hybrid search.** Deferred until keyword search is shown to
  miss; the search sits behind one function of the Module, so a library with
  vectors can replace MiniSearch later.

## Amendment 2026-10-31: a generic Rule pack and a platform Module

The workspace deployment doctrine was one 22 KB file that loaded in every
repository of the workspace, including those that deploy nothing. It describes
one Operator's cluster, so it does not fit a Rule pack, which is generic and
publishable. It became a platform Module of its own, which only the deploying
repositories turn on; the generic infrastructure rules from the memory sort
became the Rule pack of `infra`, and the rules about one cloud provider went
with the platform. Most of the doctrine is a template or a checklist that
matters only while one kind of file is written, so those parts are path-scoped
rules, and one short rule that always loads names them. A path-scoped rule
arrives only with the result of the first read or write of a matching file, so
that short rule tells the agent to read the matching rule before it creates
such a file. The scoping is Claude Code's; a harness without it loads every
part. The platform Module is not part of the kalfa package: it lives in the
infrastructure repository it describes, and kalfa finds it through the machine
setting `module-dirs` (ADR 0001, amendment of the same day).

## Amendment 2026-11-08: budgets decide what loads, never what is stored

The rule that refused a write over budget made memory the Operator's work. The
budgets had been set a little above the measured size, so every layer was full
from the first day; within a week the project layer of the infrastructure
repository refused a rule the Operator had just stated, the opposite of "what
the Operator states is written at once". The session start never needed the
refusal: it already loaded every rule and left out the index lines that did not
fit. The history showed the cost of the refusal instead: 64 supersedes, many of
them merges made only to free bytes, and summaries cut down to "Body has all",
an index line that tells the agent nothing.

**A write is never refused for space.** `add`, `supersede` and `activate` store
the record whatever the layer holds; only the length of a rule is still
checked, because it is about a rule being exact, not about room.

**A layer has two tiers.** The Loaded tier is every active rule and the index
lines that fit the budget; the Stored tier is every other active record. A
Stored record is not lost and not hidden: the session start names how many
there are and how to reach them, and recall at the session start and on demand
searches them with everything else. The budget is now only the price of the
context, so the project layer's default is 8192 B.

**The Loaded tier is ranked by use.** A record's rank is the later of the day
it was last confirmed and the day it was last used: read with `kalfa memory
show`, or returned by `kalfa memory search`. Automatic recall does not count, so
a record does not keep itself loaded. The days of use live in the cache folder,
one file per layer, outside the Memory home: they change on every read, and
their loss only falls back to the confirmed date.

**Upkeep happens at Task close.** When a layer is over budget, the Task-close
question also carries the agent's proposals to merge likely duplicates and to
close finished open items. The Operator answers once; no work waits on it.

**Deferred work is not memory.** A deferred item is work the Operator has not
taken on, so it moves from the Memory records to a deferred list that the
`plans` Module keeps in the Memory home, private as the Project layer is, and
reports at the session start beside the Plans.

## Amendment 2026-11-12: the session context fits the harness

The session start sent every part of Standing memory in one hook output, and
the budgets counted each layer, never the whole. Claude Code caps a hook's
`additionalContext` at 10,000 characters, measured for each hook command on
its own, and above the cap it gives the model only a 2,000-character preview
and the path of a file it does not ask the model to read. In the kalfa
repository the output was 18,064 characters: the model saw about half of the
Personal rules, and none of the Project layer, the Plans or the Tasks. The
instruction files of the harness have no such cap: Claude Code loads a
CLAUDE.md, its `@` imports and the files in `~/.claude/rules/` in full, up to
4 MiB, at the stable start of the prompt. Splitting the output over several
hook commands was set aside, because the number of hooks would have to grow
with memory and each one would load the project again.

**The Personal layer goes to an instruction file.** A Capability,
`instruction-file`, says the harness loads a user file of instructions in full
at every session start; the Claude Adapter names
`~/.claude/rules/kalfa-memory.md`. `kalfa install` writes the file and records
it in `install.yaml`, and `kalfa uninstall` removes it. Every write to the
Personal layer, and every session start, writes it again from the Loaded tier,
so the next session has the current records; the file says it is generated and
that a change goes through `kalfa memory`. The Personal layer is the largest
part and the same in every repository, so it gains most from a place without a
cap. Under a harness without the Capability, or before `kalfa install`, the
Personal layer stays in the session report.

**The session report has one budget.** What changes with the repository stays
in the hook: the Project layer, the Recap, the Plans, the Tasks, recall and the
deferred items. The Adapter states its cap, and the report is fitted under it
with room left for the other Modules: rules always load, and the Project
layer's index lines fill what the Recap, the Plans and the Tasks leave, the
rest going to the Stored tier. The open Tasks other than the branch's are
named in one line each, only the three most recently written, with a count of
the rest. A report past nine tenths of the cap prints a line to the Operator
at that session start, and `kalfa doctor` shows its size against the cap.
