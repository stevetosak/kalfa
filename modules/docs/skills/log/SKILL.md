---
name: log
description: Writes the Log of a kalfa Task before its pull request, from a draft that `kalfa docs draft` makes out of the Task Record, or records why the work needs none. Use at the end of a Task, after `kalfa task close`, before `gh pr create`, when the docs gate refuses a PR for the Definition of Done, or when the user says write the Log or close the docs.
---

# Write the Log of a Task

A pull request is done when it holds a Log for its work: a file under one of
the `logs` globs of `kalfa.yaml` (default `docs/logs/**/*.md`), added or
changed on the branch. The docs gate refuses `gh pr create` without one.
The Log says what a later reader needs from this work, not everything that
happened.

1. **Decide if a later reader needs anything.** A typo fix, a test-only
   change or a dependency bump often needs no Log. Then put one line in the
   PR body, `Docs: none — <reason>`, and stop here. The line stays visible in
   the PR, so the skip is on record.
2. **Draft it**: `kalfa docs draft --out <logs folder>/` (add
   `--task <id>` when the Task is not the one of the checked-out branch). The
   draft holds each Section's Done, Found and Decisions parts, then the
   Lesson candidates and the Next step. Without `--out` it only prints.
3. **Edit the draft into a Log.** Follow the site's own rules for Logs when
   the repository has them (a docs skill, a Contract, a Style Guide). Cut
   what a later reader does not need; keep each fault with its proof and each
   decision with its reason. Remove the draft comment.
4. **Fix the pages the work made stale** (a procedure or reference that now
   says something false) in the same branch. The gate cannot see this; you
   can.
5. **Check and commit**: `kalfa docs check` says whether the branch now holds
   a Log. Commit the Log with the work, then open the PR.
