---
name: defer
description: Records work for later, without starting it - as a deferred item (one entry in the private deferred list, kalfa defer) or as a proposed Plan (a Plan page with status proposed, steps and a Done when line per part). Use when the Operator says "add this as a deferred item", "defer this", "park this", "add a plan for this", "make this a deferred plan", or types /defer.
argument-hint: item | plan  <what to defer>
---

# Defer work

Deferred work is recorded, never started. Do not start a Task, change code
or make a step of it now.

## 1. Item or Plan

Take the kind from the Operator's word:

| The Operator says | Kind |
|---|---|
| "deferred item", "defer this", "park this", "note it for later" | **Item** |
| "plan", "deferred plan", "proposed plan", "make a plan for this" | **Plan** |

If the word does not say which, ask one question: item (one line in memory)
or Plan (a page with steps)? Do not choose for the Operator.

## 2a. Item: one entry in the deferred list

```
kalfa defer add --layer project --summary "<what>" [--when "<what brings it back>"]
```

- Body on stdin: why it is deferred and the source (PR, issue, Plan,
  session).
- `--when` only if the Operator gave a condition. A condition is only
  something to report. When it holds, tell the Operator; it never starts
  the work.
- Use `--layer personal` only when the item is about no one repository.
- The list is private (the Memory home), not memory: it is not a Memory
  record, and it does not load as one.
- Give the Operator the id that `kalfa defer add` prints.
- When the Operator takes an item on, run `kalfa defer take <id> "<the Plan
  or Task it became>"`; when the Operator drops it, `kalfa defer drop <id>
  "<why>"`. Never on your own.

## 2b. Plan: a page with status proposed

1. Find where Plans live: the `plans:` globs in `kalfa.yaml`, and the paths
   that `kalfa plan list --all` shows. Put the new page next to the others.
2. If the repository publishes its docs through a docs-writing skill (its
   rules or an enabled Module name one), load it first: its rules decide the
   front matter and the style.
3. Write the page:

   ```markdown
   ---
   title: "<Subject>: <the result in a few words>"
   type: plan
   status: proposed
   ---

   <Why the work is needed, why it waits, and what brings it back.>

   ## <Part name>

   **Done when:** <a check that can be true or false>

   - [ ] <step>
   - [ ] <step>
   ```

   - Every part has a **Done when:** line above its steps. A proposed Plan
     is open, so `kalfa plan check` requires it.
   - Steps are what is known now. Do not invent detail: a step can be
     "Decide X in a grill" when the design is still open.
4. Run `kalfa plan check`. It must report nothing for the new page.
5. Commit on a branch. Pushing and the PR follow the repository's rules.

## 3. Report

One or two lines: the kind, the record id or the page path, and the
condition that brings it back. `/kalfa-status` shows both kinds.
