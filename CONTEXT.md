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
A harness-neutral moment in a session that Modules handle: `session.start`, `prompt.submit`, `command.before`, `tool.after`, `section.close` or `task.close`.
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
The private, git-ignored file that holds one Task's Sections, findings with proof, decisions, Lesson candidates and next steps.
_Avoid_: brief, notes, journal

**Handoff**:
A short view of a Task Record that a fresh session reads to continue the work.
_Avoid_: summary, context dump

**Plan**:
A tracked list of the steps of a larger piece of work, with the state of each step.
_Avoid_: roadmap, backlog, todo

**Memory candidate**:
A finding from a Task (a possible rule, fact, decision or open item), with its proof, kept until the Operator accepts or drops it. Candidates not yet answered wait in the inbox of the Memory home.
_Avoid_: Lesson candidate, learning, takeaway

**Lesson**:
An accepted rule that came from a fault, with a link to the proof of that fault.
_Avoid_: learning, takeaway

### Memory

**Memory layer**:
One of three scopes of standing agent memory, each with its own budget: the personal layer, the Module rule packs and the project layer.
_Avoid_: memory file, context

**Personal layer**:
The operator's private memory that loads in every session: profile, generic preferences, generic standing rules and cross-project Lessons.
_Avoid_: global memory, user memory

**Rule pack**:
The generic, publishable domain rules a Module carries, loaded only where that Module is on.
_Avoid_: domain memory, guidelines

**Project layer**:
The private memory of one repository: its sessions, decisions and environment facts. It is kept outside the repository, in the Memory home, and every work tree and clone of the repository shares it.
_Avoid_: local memory, repo notes

**Memory home**:
The one private place, with its own history, that holds the Personal layer and every Project layer. It is never inside a project repository.
_Avoid_: memory store, memory dir

**Standing memory**:
The memory that must be in every session where it applies: the in-scope part of the three Memory layers, under their budgets. The Core owns it, so it never depends on a Module being on.
_Avoid_: always-on memory, context

**Memory record**:
One piece of memory in one file, of one type: a rule (how to act; a Lesson is a rule), a fact (how something is), a decision (what was chosen and why) or an open item (left open on purpose). It has a status and the date it was last confirmed, a newer record can supersede it, and a record whose work is done, or that no longer applies, is closed: it stops loading, and search still finds it. Its layer is its scope.
_Avoid_: memory entry, note, memory file

**Recall memory**:
The memory that is captured, searched, promoted and checked on demand rather than loaded every time. A replaceable Module owns it.
_Avoid_: long-term memory, archive
