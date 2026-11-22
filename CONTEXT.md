# kalfa

kalfa is a method and a toolset for working with coding agents across many
projects. It holds the workflow, the guardrails and the agent tooling once, and
each project turns on only the parts it uses. The name is the journeyman who
works under the master: the agent works, the operator decides.

## Language

### People

**Operator**:
The person who directs the agent, approves risky actions and owns every decision.
_Avoid_: user, owner, master

### Structure

**Core**:
The harness-neutral part of kalfa: the instruction fragments, the portable skills and the one CLI that holds all logic.
_Avoid_: base, kernel

**Adapter**:
The thin, per-harness part that translates one agent harness's hooks, files and features to and from the Core.
_Avoid_: plugin, driver, integration

**Harness**:
The agent program a session runs in, such as Claude Code, Codex, Cursor or Gemini CLI.
_Avoid_: agent (when the program is meant), client, tool

**Module**:
An opt-in package of skills, CLIs, rules, pinned third-party skills and overlays that a project turns on in its project file.
_Avoid_: plugin, extension, pack

**Project file**:
The committed `kalfa.yaml` at a repository's root that names the Modules the project turns on.
_Avoid_: config, manifest

**Overlay**:
Text that kalfa appends to a third-party skill at build time, so the skill gets local rules without being edited in place.
_Avoid_: patch, fork

**Capability**:
A harness feature that a Module declares it needs, together with what the Module does when the harness lacks it.
_Avoid_: feature flag, requirement

### Events

**Core event**:
A harness-neutral moment in a session that Modules handle: `session.start`, `prompt.submit`, `command.before`, `tool.after`, `compact.before`, `compact.after`, `section.close` or `task.close`.
_Avoid_: hook (for the neutral event), trigger

**Dispatcher**:
The single entry point that receives a harness hook, turns it into a Core event and runs the handlers of the enabled Modules.
_Avoid_: router, hook runner

### Work

**Task**:
One unit of work with one goal, closed when its Definition of Done holds.
_Avoid_: ticket, job, chunk

**Section**:
One logical step inside a Task, recorded when it closes.
_Avoid_: chunk, phase, step

**Task Record**:
The private, git-ignored file that holds one Task's Sections: what was done, findings with proof, decisions, the findings to keep and next steps.
_Avoid_: brief, notes, journal

**Handoff**:
A short view of a Task Record that a fresh session reads to continue the work.
_Avoid_: summary, context dump

**Checkpoint**:
The summary a harness wrote when it compacted a session that works on a Task, kept next to the Task Record; the newest one tells where the session stood.
_Avoid_: snapshot, save point

**Recap**:
Where the work of a repository stood, joined from its Plan, its last Task Record, the last Checkpoint and the commits since; a new session after some idle days starts with it.
_Avoid_: recap of a session (the harness's own `/recap`), status, summary

**Plan**:
A tracked list of the steps of a larger piece of work, with the state of each step.
_Avoid_: roadmap, backlog, todo

**Deferred item**:
Work the Operator has named but not taken on, with the condition that brings it back. It lives in the private deferred list of its Memory layer, not in the repository, and it is not a Memory record: it leaves the list when the Operator takes it on (it becomes a Plan or a Task) or drops it. A condition is only reported; it never starts the work.
_Avoid_: deferred record, backlog item, parked task

**Cleanup**:
The agent's reconciling of a closed Task Record into Long-term memory and the Rule packs, from the findings in its Sections' Remember parts, with the upkeep of a layer over its budget; kalfa gives its steps at Task close, and after it `kalfa task reconciled` marks the record reconciled. The records closed before the Cleanup existed had their findings sent to the inbox, so `kalfa memory migrate` marks them reconciled without one, once per repository. A closed record that missed its Cleanup is named at session start and taken in by the next Task close's Cleanup.
_Avoid_: consolidation, reflection, memory review, Memory candidate

**Remember part**:
The `**Remember:**` part of a Section: one bullet per finding the Cleanup takes into Long-term memory. The old part names Memory candidates and Lesson candidates are read as it.
_Avoid_: Keep part (`section close --keep` keeps the session's context), Memory candidates, Lesson candidates

### Sessions

**Workspace**:
The Herdr workspace of one repository, labelled with the repository's folder name; its tabs hold the agent sessions and tools of that repository and of its worktrees.
_Avoid_: space, project window, session group

**Preset**:
A named, ordered list of tabs (agent tabs and command tabs) that a Workspace opens with; it is the Operator's own, kept in the machine settings.
_Avoid_: layout, template, profile

**Main checkout**:
The repository's first working folder, the one its worktrees point back to; it holds the private state of every worktree's Tasks.
_Avoid_: main worktree, primary clone

**Board**:
The list of every agent session in every Workspace, with its Task, state, context, idle time, cache state and Next.
_Avoid_: dashboard, overview

**Auto mode**:
A mode of one session, turned on only for an autonomous run, in which the session resets itself at Section boundaries past the compact point instead of asking the Operator to compact.
_Avoid_: autonomous compaction (for the mode), smart compaction, autopilot

**Reset**:
A Section close, a `/clear` and a continue word in one session, so the work goes on from the Task Record with a small context; in Auto mode it happens without the Operator.
_Avoid_: compaction (a `/compact` is not a Reset), restart, handoff

### Memory

**Short-term memory**:
The detailed memory of a project's recent work: the Task Records and Checkpoints of its open Tasks, and of each closed Task whose Plan is still open, that an open Task names, or that closed only a few Active days ago. The agent cleans it up into Long-term memory; only then can a record leave it, and leaving moves the record and its Checkpoints to the archive in the Memory home, where search still finds it.
_Avoid_: working memory, session memory, journal

**Active day**:
A day with a commit or a session start in a repository; the age of a closed Task counts in these, so idle days do not age it.
_Avoid_: working day, business day

**Long-term memory**:
The reconciled, lasting memory of the agent: Memory records in the Memory home, linked to each other, that the agent retrieves as the work needs them, not all at once.
_Avoid_: standing memory, recall memory, archive, knowledge base

**Hub**:
A Memory record that maps one subject: a short text and the links to the records of that subject.
_Avoid_: index, topic, map of content

**Root Hub**:
The top Hub of a Memory layer: a short map of the layer, with links to its subject Hubs, that loads at every session start. Its id is `root`; after a supersede, the record at the end of the chain takes its place.
_Avoid_: index, home page, MEMORY.md

**Memory layer**:
One of the two private scopes in the Memory home, each with its Long-term memory and its private Rule pack: the Personal layer and the Project layer.
_Avoid_: memory file, context

**Personal layer**:
The Operator's private layer that applies in every project: what the agent knows about the Operator and the work in general, and the rules that hold everywhere.
_Avoid_: global memory, user memory

**Project layer**:
The private layer of one repository: its decisions, environment facts and rules. It is kept outside the repository, in the Memory home, and every work tree and clone of the repository shares it.
_Avoid_: local memory, repo notes

**Memory home**:
The one private place, with its own history, that holds the Personal layer and every Project layer. It is never inside a project repository.
_Avoid_: memory store, memory dir

**Memory record**:
One piece of Long-term memory in one file, of one type: a fact (how something is), a decision (what was chosen and why), an open item (left open on purpose) or a Hub. It links to related records, has a status and the date it was last confirmed; a newer record can supersede it, and a closed one stays searchable. Its layer is its scope.
_Avoid_: memory entry, note, memory file

### Instructions

**Rule pack**:
A set of rules in harness-neutral files, each loaded at every session start, only when the agent touches a matching file, or as a skill when the work fits it. A Module's Rule pack is generic and public; a Memory layer's Rule pack is private and lives in the Memory home, where `kalfa rule` writes it.
_Avoid_: domain memory, guidelines, rule records

**Instruction file**:
A harness file that kalfa writes from a Rule pack, so the harness loads its rules natively: always, or for matching paths. For Claude Code it is a file under `.claude/rules/` of the repository or of the user's home.
_Avoid_: rules file, CLAUDE.md, memory file

**Lesson**:
A rule that came from a fault, with a link to the Memory record that holds the proof of that fault.
_Avoid_: learning, takeaway
