---
name: kalfa-status
description: Shows a summary of the open work of the current kalfa repository - active and proposed Plans with their next step, open Tasks, deferred items from the deferred list, and the Plan faults that `kalfa plan check` finds. Use when the Operator types /kalfa-status, or asks what is open, what is deferred, what Plans or Tasks are active, or where the work stands.
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
   - `kalfa defer list` — the open deferred items of this repository and of
     the Personal layer, with the condition that brings each back.
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
| Search: results in under a second | 3 of 12 | Add the index on the title column … |

**Proposed Plans** (N)
| Plan | Steps | Path |
|---|---|---|
| Exports: CSV for every report | 0 of 5 | docs/plans/exports-csv-for-every-report.md |

**Tasks** (N open)
- `search-index` — Search Plan Phase 1: the title index
  - **Waits for you:** approve the migration on the staging database …
  - Plan: Search: results in under a second
  - Done when: a title search returns in under a second on staging …

**Deferred items** (N)
- `dark-mode` (2026-10-22): dark mode for the settings pages.
  When: the settings pages get their redesign.

**Plan check**
- docs/plans/billing-move-to-a-new-provider.md: Phase 2 has no **Done when:** line.
```

- A section with nothing in it is one line: "Proposed Plans: none."
- If `kalfa plan check` finds nothing, write "Plan check: no faults."
- A Task whose Next step waits for the Operator comes first, and its first
  line starts with **Waits for you:**. Other Tasks show "Next:" in that place.
- A Task's Next step can be out of date (for example, a PR it waits for is
  already merged). Show what the Task Record says; do not check it.
- Do not add advice or start work. End after the summary.
