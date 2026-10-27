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

- [ ] CLI skeleton, `kalfa.yaml` schema 1, machine settings file.
- [ ] Dispatcher `kalfa hook <event>` with the fast path.
- [ ] Claude Code Adapter: hook translation, task-list mapping, Capability set.
- [ ] Task Record (schema 1), the git-ignore refusal, the Handoff view.
- [ ] Plans: the portable format, globs in `kalfa.yaml`, the session report.
- [ ] `kalfa build` keeps APM project state (`apm.yml`, `apm.lock.yaml`) out of the repository and composes Overlays from the pinned upstream skill.
- [ ] Decide whether the nested `AGENTS.md` files that `apm compile` writes are committed or ignored.
- [ ] `kalfa build`, `kalfa doctor`, `kalfa link` / `unlink`, `kalfa init`.
- [ ] Tests: unit, Adapter contract on recorded payloads, clean-state smoke.
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
