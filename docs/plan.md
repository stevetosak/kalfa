---
title: "kalfa — build and migration"
description: "The steps that build kalfa beside the old agent setup and move every project onto it, one Core event at a time."
type: plan
status: active
topics: [agents, tooling]
---

The shape is fixed in [ADR 0001](adr/0001-kalfa-shape.md); the vocabulary is in
[`CONTEXT.md`](../CONTEXT.md). The old setup keeps running until each of its
events is switched, so other work can go on during the migration.

## 1. APM spike

In a throwaway repository. A part that fails here is built by hand, and only
that part. Result: [APM spike Log](spikes/2026-10-27-apm.md).

- [x] Install a pinned third-party skill at user scope and read it back from the lock file.
- [x] Merge hooks into the harness settings and keep a foreign hook untouched.
- [x] Apply an Overlay to a third-party skill through a local path. APM cannot keep it next to the upstream skill; `kalfa build` composes it (see the spike Log).
- [x] Uninstall and leave nothing behind.
- [x] Check how Claude Code reads `AGENTS.md`: on its own only when no `CLAUDE.md` exists; otherwise only through `@AGENTS.md`.
- [x] Check whether APM's `applyTo` instruction compile can produce the per-harness rule files.
- [x] Record the pinned APM version and the result of each item.

## 2. Core, unwired

- [x] CLI skeleton, `kalfa.yaml` schema 1, machine settings file.
- [x] Dispatcher `kalfa hook <harness> <event>` with the fast path: the `kalfa-hook` shim starts Node only when the Core or the repository's event table handles the event.
- [x] Claude Code Adapter: hook translation and Capability set, with contract tests on payloads recorded from Claude Code 2.1.311 (`scripts/record-claude-fixtures.sh`).
- [x] Task Record (schema 1) written through `kalfa task` and `kalfa section close` (parts as Markdown on stdin), the git-ignore refusal, the Handoff view, the task-list mapping (fallback: the Section stays in the record only).
- [x] Plans: the portable format (the documentation site Contract's steps), `plans:` globs in `kalfa.yaml`, the session report, `kalfa plan list` / `show` / `check`, and `kalfa task start --plan` checks the page.
- [x] `kalfa build` keeps APM project state out of the repository: it writes the Module files itself and APM stays at user scope (amendment to ADR 0001). It composes Overlays from the pinned upstream skill and records each pin's hash.
- [x] Decide whether the nested `AGENTS.md` files are committed or ignored: none while Claude Code is the only harness; then each one goes in `.git/info/exclude`.
- [x] `kalfa build`, `kalfa doctor`, `kalfa link` / `unlink`, `kalfa init`.
- [x] `kalfa doctor` names skill references in `CLAUDE.md` and `AGENTS.md` that no installed skill answers (the Adapter says where its harness finds skills and commands).
- [x] Tests: unit, Adapter contract on recorded payloads, clean-state smoke (`kalfa doctor --smoke`: install, the `.kalfa/` refusal, init, build next to the Operator's own settings, hooks through the shim, uninstall leaves nothing).
- [x] CI: the three test levels and the leak scan (`.github/workflows/ci.yml`; the leak scan reads its words from the repository secret `KALFA_LEAK_PATTERN`). `main` takes pull requests only, with both checks required.

## 3. Modules from the old setup

The old hooks keep running while these are built.

- [x] `docs` (thin): the Definition of Done gate before `gh pr create` (a Log is a file under the `logs` globs of `kalfa.yaml`; `Docs: none — <reason>` in the PR body skips it), `kalfa docs check`, and the recorder `kalfa docs draft`, which drafts the Log from the Task Record. The site-specific parts stay with the documentation site until its redesign.
- [x] `guardrails`: no push to a protected branch in any form (a `command.before` handler that fails closed; `settings.guardrails.protected-branches`, default `main` and `master`), and approval prompts before git commands that throw work away.
- [x] `infra`: approval prompts before every terraform command and the kubectl verbs that write. Its rule pack comes from the memory sort (step 5).
- [x] A Module can give a payload filter per event, so the shim starts Node only for a payload its handler acts on, and its own `settings:` part in `kalfa.yaml`.
- [x] `meter`: the context meter and `/meter`, the idle guard, the status-line tap (it saves the usage limits), `kalfa meter usage`. The Core gained a quiet prompt block, a turn stop, the subagent marker, the tool duration, the `usage` Capability, and a context size per event in the event table (each Adapter ships a context probe, so a small session never starts Node).
- [x] `herdr`: the successor launch (`kalfa herdr continue`, the `successor` skill): a new session on the open Task, in a Herdr tab or in the harness's background session, refused near a usage limit. Herdr's own integration shows the session state; the Module says when it is missing.
- [x] Move the existing agent tests with their code. Each old test runs next to its kalfa code: the PR command and the gate in `docs`, the launcher in `herdr`, the guard, the prices and the usage report in `meter`, the transcript reader with the Claude Adapter, the handoff's limit check in the Core usage limits, open Plans and the Handoff after `/clear` in the Core session report. Not moved: the documentation site keeps its own (page guides, the docs work tree, the Lesson inbox, the Procedure or Reference check); the hook install and the status-line wrap come with step 4, the memory budget with step 5.
- [x] Decide for each loose personal skill: move it into a Module or drop it. The documentation site's `meter`, `handoff`, `close-task` and `docs-from-brief` retire at the step 4 switch (kalfa's `meter`, the Task Record, `herdr` and `docs` replace them); its page-writing skill stays with the site. The Operator dropped `discuss` and the unpinned `docker-development` copy.

## 4. Switch, one event at a time

Each switch is proven in a real session. The settings backup is the rollback.
The Operator chose a working prototype first: the hooks are wired by hand in
one change, and the `docs` Module stays unwired until later. The old
documentation gate before a pull request is removed; the old session report
stays beside kalfa's, because it reports the documentation site's Plans and
handoffs.

- [x] Machine-level Modules: `modules:` in the machine settings run in every session, in every repository and outside one; `kalfa.yaml` adds the project's. Personal Modules (the meter) never go in a committed file. Outside a kalfa project the shim reads a machine event table.
- [x] `session.start`
- [x] `command.before` (the push rule; the guardrails approvals as user-level `permissions.ask`)
- [x] The meter (`prompt.submit`, `tool.after`)
- [x] The status line
- [x] Remove the dead stop hook.
- [x] Later: `kalfa install` writes the harness hooks at user scope, and the smoke checks that a foreign hook stays. (Proven live 2026-10-31: a session started through `dist/kalfa-hook`.)
- [ ] Later: design the human `docs` Module in its own grill. The current `docs` Module is parked, not wired: memory takes over the agent's need for Logs ([ADR 0002](adr/0002-memory.md)), and the existing Logs stay as search corpus.

## 5. Memory

The design is [ADR 0002](adr/0002-memory.md). It comes before the projects, so
each project starts on kalfa with its Project layer already sorted.

- [x] Core: the Memory home (one private folder with its own git history), Memory records, `kalfa memory add|supersede|confirm|show|list`, and the injection of the Personal and Project layers at `session.start` under a rule count and a byte budget (settings). (Built 2026-10-31; the clean-state smoke proves it. Not live until the sort writes records.)
- [x] The `memory` Module: MiniSearch over the Memory home, the Task Records, the project documentation and the old archives; recall at `session.start` from the open Task; `recall-on-prompt` as a setting, off; Memory candidates (the Section part replaces Lesson candidates), the question at Task close and the inbox; the lint; the Task Record copied into the Memory home at close. (Built 2026-10-31; the clean-state smoke proves it. Turned on per machine or per repository.)
- [x] Sort the current memory into the three layers as proposed records; the Operator reviews the sort one layer at a time before anything moves. (Reviewed 2026-10-31: 79 proposed records in the Personal layer and four Project layers; the generic infrastructure rules wait for the Rule pack. Measured: Personal 26 rules and 7.4 KB in all, the largest Project layer 5.1 KB, against about 44 KB of memory files today.)
- [x] The switch: the proposed records become active, the old memory files go to a backup, `kalfa install` turns off the harness's own automatic memory, and the Operator changes the machine policy to write memory through `kalfa memory`. Set the budgets from the measured size. (Switched 2026-10-31: 80 active records; a new session in the kalfa repository receives 28 rules and 18 index lines at `session.start`, and the harness's own memory section is gone from its system prompt.)
- [x] Move the generic infrastructure rules into the `infra` Module's Rule pack, and the workspace deployment doctrine into a platform Module of its own, with path-scoped parts ([ADR 0002](adr/0002-memory.md), amendment). The platform Module lives in the cloud-infra repository; the machine setting `module-dirs` finds it ([ADR 0001](adr/0001-kalfa-shape.md), amendment). (Proven 2026-10-31 in a scratch repository: the unscoped rules load at the session start, the Docker part only when a Dockerfile is read.)

## 6. Projects

- [x] cloud-infra: `kalfa.yaml` with `infra` and the platform Module, build, a full Task closed through kalfa. The doctrine's table of deployed projects moves to a Reference page here; the generator list stays its source.
- [x] doma: Modules without `docs` (the platform Module on). No bridge: doma has no `CLAUDE.md` and no Claude-only lines, so Claude Code reads `AGENTS.md` itself.
- [x] Authos: `kalfa.yaml` with the platform Module.
- [x] symbiosis: the Core alone.

## 7. Retire the old setup

- [ ] Remove the agent folder from the documentation-site repository; the site stays.
- [ ] Remove the workspace doctrine `~/Projects/Active/CLAUDE.md` once cloud-infra, doma and Authos build with the platform Module on.
- [ ] Tag the first release.
