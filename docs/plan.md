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
- [ ] CI: the three test levels and the leak scan.

## 3. Modules from the old setup

The old hooks keep running while these are built.

- [ ] `docs`: the documentation recorder, the Definition of Done, the push gate's documentation check.
- [ ] `guardrails`: the push gate's hard rules, the approval lists, a generic infrastructure rule pack.
- [ ] `meter`: the context meter, the idle guard, the status line, the rate tap, the usage report.
- [ ] `herdr`: session state and the successor launch.
- [ ] Move the existing agent tests with their code.
- [ ] Decide for each loose personal skill: move it into a Module or drop it.

## 4. Switch, one event at a time

Each switch is proven in a real session before the old entry is removed. The
settings backup is the rollback.

- [ ] `session.start`
- [ ] `command.before` (the push gate)
- [ ] The meter (`prompt.submit`, `tool.after`)
- [ ] The status line
- [ ] Remove the dead stop hook.
- [ ] The smoke also installs the harness hooks at user scope and checks that a foreign hook stays.

## 5. Projects

- [ ] cloud-infra: `kalfa.yaml`, build, a full Task closed through kalfa.
- [ ] doma: the `AGENTS.md` bridge, Modules without `docs`.
- [ ] symbiosis: the Core alone.

## 6. Memory

- [ ] Sort the current memory into the three layers; the operator reviews the sort before anything moves.
- [ ] Move the workspace deployment doctrine into the infrastructure Module.
- [ ] Enforce each layer's budget at `session.start`.

## 7. Retire the old setup

- [ ] Remove the agent folder from the documentation-site repository; the site stays.
- [ ] Tag the first release.
