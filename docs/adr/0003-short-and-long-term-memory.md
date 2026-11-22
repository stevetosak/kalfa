---
status: accepted
date: 2026-11-22
---

# Memory: Short-term and Long-term memory, rules apart from memory

ADR 0002 loaded Standing memory into every session: every rule in full and as
many index lines as the budgets allowed. Three weeks later the load did not fit
the work. On 2026-11-22 the session report of the kalfa repository was 9,640
characters, 60% of it the Project layer's index lines, and the personal
instruction file added 15,743 characters, 11,367 of them rules. The report of
the infrastructure repository was 14,388 characters, over the harness's
10,000-character cap, so its agents saw only a preview. Size was not the main
cost: about two thirds of the 31 personal rules applied only to some work (a
kernel upgrade, terraform, one platform's design, docs writing), and every one
loaded in every repository. The review of Memory candidates had also stopped:
19 proposed records and 4 inbox candidates waited with no answer, and the
Operator decided that the agent manages its findings itself, with no review.

Memory now has two kinds, and rules are no longer memory. The model follows
the shape that agent-memory designs share: tiered memory that is paged in
(MemGPT), raw experience reconciled into lasting memories (the reflection of
Generative Agents) and small linked notes with maps (A-MEM, after the
Zettelkasten).

**Short-term memory is the Task Records.** The Task Records and Checkpoints of
a project's open Tasks, and of each closed Task that open work still needs,
hold the details of recent work; there is no second store. A closed Task stays
while its Plan is active or an open Task links to it, or while it closed fewer
than five Active days ago, a day with a commit or a session start in the
repository. A count of Tasks was rejected because parallel work closes many
Tasks at once (ten closed in kalfa on 2026-10-31), and calendar age because an
idle project would forget exactly the Tasks a return needs. A record leaves only
after its Cleanup, and leaving moves it and its Checkpoints to the archive in
the Memory home, where search still finds it.

**The Cleanup reconciles a closed Task into Long-term memory.** At Task close
the agent reads the record, takes each finding a Section marked in its Keep
part, and updates, supersedes, confirms or adds the Memory record for it,
linked into its subject's Hub and to related records, with the Task Record as
its source; a finding that is a rule goes to a Rule pack. kalfa then marks the
record reconciled. Running the Cleanup at each Section close was rejected
because an early Section's finding is often wrong by the last one; a scheduled
headless run was rejected because it starts work with no one present. A closed
record that missed its Cleanup is named at session start and reconciled at the
next Task close, and a Task with no write for seven days gets a note. A finding
from a session without a Task goes straight to Long-term memory, reconciled
while its context is still there.

**Long-term memory is small linked records with Hubs.** A Memory record holds
one fact, decision or open item; a Hub maps one subject with links to its
records, and the Root Hub of each layer maps the layer. Links are `[[id]]` in
the body, untyped, so the sentence around a link says why it is there; a
project record links to a personal one as `[[personal:id]]`, and a personal
record never links into one project. Back-links are found when a record is
read, and `kalfa memory show` returns a record with the summary line of each
neighbour, to a chosen depth, so the agent goes deeper only when the summaries
are not enough. One note per subject was rejected because every change
rewrites the subject and a supersede must replace all of it; typed links were
rejected because each write must pick a type from a list that drifts. The
`proposed` status and the inbox go: what the agent finds, it writes.

**The session start loads a map, not the memory.** It loads the Root Hub of the
Project layer and of the Personal layer (1,500 characters each at most), the
current Task's Short-term memory as before, one line for each open Task and
Plan, and a count of the deferred items; no index lines. On the first prompt
of a session one search with the prompt and the Task adds the best few
summaries, because the session-start hook runs before the prompt and, on a
branch without a Task, has nothing to search with. After that the agent pulls
with `kalfa memory show` and `search`. Searching on every prompt waits for
data: each prompt's hits go to a shadow log and are not injected, and after two
weeks of use the log is compared with what the agent searched for and read.
Search ranks Long-term records first, then Short-term, then the archive, and
by use within each.

**Rules are private Rule packs, outside memory.** Each Memory layer keeps its
rules in a Rule pack in the Memory home, in the format of a Module's Rule pack,
and kalfa writes them as Instruction files: the personal rules under the
user's `.claude/rules/`, a project's under the repository's `.claude/rules/`,
which git ignores, as it already does for the Module Rule packs. The file stays
private and versioned in one place, and each Adapter writes its own harness's
form. A rule has one of four forms, chosen with two tests: whether forgetting
it at some moment causes harm (if not, it is memory), and whether that moment
is a file path, a kind of work or an action kalfa can block. The answers give a
path-scoped rule, a skill or a hook; the rest load always. A Lesson's rule
stays short and links to the Memory record that holds the proof of its fault.
Writing the harness files by hand was rejected because they have no history,
fit one harness, and a new worktree does not get a git-ignored file; a private
Module per project was rejected as too heavy for one stated rule.

**The Core owns the rules; the memory Module owns Long-term memory.** The reason
for ADR 0002's split stays, but it now falls between rules and memory: the Core
owns the private Rule packs and their Instruction files (`kalfa rule
add|change|remove`), the Task Records with the Short-term window and the
archive, and the Memory home with its record format, which the Core's own
commands read too. The memory Module owns Long-term memory and `kalfa memory`,
the Root Hubs at the start, recall, the shadow log, the Cleanup and the lint,
and it can still be replaced as a whole. Without it no rule is lost; closed Task
Records simply stay in Short-term memory, because nothing reconciles them.

**A harness without a feature loads more, never less.** Two Capabilities are
new: `path-rules`, without which a path-scoped rule loads always, and
`skills`, without which a skill-form rule becomes one pointer line in the
rules that load always. Without `instruction-file` the rules that load always
go in the session report, as before; without `context-injection` there is no
Root Hub and no recall, and the agent pulls.

**The change-over is mechanical first, then one layer at a time.** A command
moves each rule record into its layer's Rule pack with its text unchanged and
loading always, so no session loses a rule; it marks the existing closed Task
Records reconciled, since their candidates went through the old path, and moves
those past the window to the archive. The rules leaving the session report
bring the infrastructure repository below the cap. Then a Task for each layer
picks the form of each rule, writes the Hubs and links, and decides each
proposed record and inbox item, in the order kalfa, personal, the
infrastructure repository, the rest. Until a layer has its Root Hub, it loads
its index lines as before.

## What this changes in ADR 0002

Standing memory and Recall memory are replaced by Short-term and Long-term
memory, and the rule type leaves the Memory record. The approval that followed
the source ends: the agent writes what it finds, and what the Operator states is
still written at once, a rule to its Rule pack and anything else to Long-term
memory. The budgets no longer decide which index lines load; the Root Hub
limit and a warning on the count of rules that load always take their place.
The Personal layer's instruction file holds only rules. The Memory home, the
file per record, the layers keyed by `origin`, keyword search with MiniSearch,
the confirm dates and the lint stay.
