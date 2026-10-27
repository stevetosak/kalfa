---
status: accepted
date: 2026-10-27
---

# kalfa is a Core with thin harness Adapters and opt-in Modules, distributed through APM

The agent setup grew inside a documentation-site repository. Its hooks ran from
that repository's paths, the documentation sources decided which projects got
the tooling at all, and every rule loaded in every project, whether the project
deployed to a cluster or not. It also spoke to one harness only. kalfa takes
that setup out into its own public repository and gives it a shape that can grow
to other projects and other harnesses.

**All logic lives in one Core CLI; an Adapter only translates.** The Core holds
the instruction fragments, the portable skills and the `kalfa` CLI. Each harness
gets a thin Adapter that turns its hooks into harness-neutral Core events
(`session.start`, `prompt.submit`, `command.before`, `tool.after`,
`section.close`, `task.close`) and back. The rule that keeps the boundary honest:
an Adapter holds no logic that a Core test cannot reach. Claude Code is the
first Adapter. A feature only one harness has is kept, not dropped: the Module
that uses it declares it as a Capability with a fallback, and `kalfa doctor`
lists what is off on each harness.

**Projects opt in to Modules.** A Module packages skills, CLIs, a rule pack,
pinned third-party skills and Overlays. A committed `kalfa.yaml` names the
Modules a repository turns on and nothing personal. The Core and the personal
skills install once at user scope; `kalfa build` links each enabled Module into
the repository as git-ignored files. A repository without `kalfa.yaml` gets the
Core alone, and the Dispatcher's fast path skips every Module handler.

**Instructions have one source per layer and are generated per harness.** A
repository's committed, hand-written `AGENTS.md` holds its own instructions, and
its `CLAUDE.md` imports it. Core and Module fragments are never pasted by hand:
`kalfa build` writes them in the form each harness reads. Memory follows the
same split into three layers with budgets: a small private personal layer, the
public rule packs of the Modules, and a private project layer.

**The work record is the Core's, and it stays private.** The Task Record, which
replaces the documentation workflow's brief, lives in `<repo>/.kalfa/`, and kalfa
refuses to write there unless git ignores the folder, because the repositories
are public. A Handoff is a view of it. Plans are a Core concept too; the other
documentation types stay in the documentation Module until that workflow is
reviewed.

**APM is the distribution layer.** Microsoft's Agent Package Manager already
installs skills, instructions and hooks to several harnesses from a lock file,
so every Module is also an APM package. kalfa keeps what APM does not do: the
event translation, the Overlays, the project file and the method. APM is
pre-1.0, so its version is pinned, and a spike proves it first. A part the spike
cannot prove is built by hand, and only that part.

## Considered options

- **One flat global setup, made smaller.** Rejected: rules and skills for one
  domain would still load in every project.
- **A per-project install, committed to each repository.** Rejected: the
  repositories are public, and every one would carry a copy of the Core.
- **Hand-rolled distribution.** Rejected while APM can do the job; it stays the
  fallback for any part the spike fails.
- **Claude Code only.** Rejected: the Core must be readable by the harnesses
  that use `AGENTS.md`, even before their Adapters exist.

## Consequences

- The migration replaces the old hooks one Core event at a time, so the push
  gate and the secret rules never have a gap.
- One semver covers the whole repository; `kalfa.yaml` and the Task Record carry
  a schema number, and `kalfa migrate` rewrites older files.
- A CI leak scan refuses personal content, since the personal layer must never
  enter this repository.

## Amendment 2026-10-27: APM at user scope only

The spike showed that APM cannot keep its project state out of a repository:
`--root` moves every write, the harness files too. Overlays already need kalfa
to fetch the pinned upstream skill itself. So `kalfa build` writes a Module's
files into a repository without APM, through the Adapter, and records what it
wrote, each pin and its hash in the git-ignored `.kalfa/build.yaml`. APM installs
what lives at user scope: the Core, the hook plugin and the personal skills.
Nested `AGENTS.md` files for other harnesses are not written while Claude Code
is the only one; once they are, each goes in `.git/info/exclude`, so a public
repository never carries them.
