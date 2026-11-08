---
name: kalfa-status
description: Shows a summary of the open work of the current kalfa repository - active and proposed Plans with their next step, open Tasks, deferred items from the Memory records, and the Plan faults that `kalfa plan check` finds. Use when the Operator types /kalfa-status, or asks what is open, what is deferred, what Plans or Tasks are active, or where the work stands.
---

# kalfa status

A read-only summary. It changes nothing: no `task start`, `task close`,
`section close` or `memory` write.

## Steps

1. If the repository has no `kalfa.yaml`, say that it is not a kalfa project
   and stop.
2. Run these together:
   - `kalfa plan list` — the open Plans: status (`active` or `proposed`),
     steps done and the next step.
   - `kalfa task list` — every Task Record. Keep only the rows with `open`.
   - `kalfa memory list --layer project` — keep the `decision` records with
     status `active` whose id or summary has the word "defer" (deferred,
     Deferred). These are the deferred items.
   - `kalfa plan check` — Plan parts without a **Done when:** line, and other faults.
3. For each open Task, run `kalfa task show --task <id>`. Take:
   - `done-when` and `plan` from the front matter,
   - the **Next:** of the LAST Section only. If there is no Section, say
     "no Section yet".
4. Write the summary in the format below. Shorten a long step to its first
   item; keep paths, ids and commands exact.

## Output format

```
**Active Plans** (N)
| Plan | Steps done | Next step |
|---|---|---|
| Email: inboxes on Stalwart | 4 of 27 | Create the B2 bucket for the message files … |

**Proposed Plans** (N)
| Plan | Steps | Path |
|---|---|---|
| Logs: Loki and an agent | 0 of 6 | docs/plans/logs-loki-and-an-agent.md |

**Tasks** (N open)
- `mail-phase-1-accounts` — Email Plan Phase 1: the account steps
  - **Waits for you:** create the B2 account, the buckets and the keys …
  - Plan: Email: inboxes on Stalwart
  - Done when: SES has production access …

**Deferred items** (N)
- `dns-writes-deferred` (2026-10-22): a Plan item decides a kluster zone-write Stage vs external-dns.

**Plan check**
- docs/runbook/rebuild-2026-09-20.md: Phase 4 has no **Done when:** line.
```

- A section with nothing in it is one line: "Proposed Plans: none."
- If `kalfa plan check` finds nothing, write "Plan check: no faults."
- A Task whose Next step waits for the Operator comes first, and its first
  line starts with **Waits for you:**. Other Tasks show "Next:" in that place.
- A Task's Next step can be out of date (for example, a PR it waits for is
  already merged). Show what the Task Record says; do not check it.
- Do not add advice or start work. End after the summary.
