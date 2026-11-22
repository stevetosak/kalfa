---
title: "Memory revision: Short-term and Long-term memory, rules apart from memory"
description: "Rules move out of memory into private Rule packs that load always, by path or as skills; Long-term memory becomes small linked records with Hubs that the agent retrieves as needed; the Task Records are Short-term memory, reconciled by the agent at Task close."
type: plan
status: active
topics: [agents, tooling]
---

[ADR 0003](adr/0003-short-and-long-term-memory.md) holds the design and its
reasons. Every session loads all rules and as many memory index lines as fit:
9,640 characters of session report in kalfa, 14,388 in the infrastructure
repository (over the 10,000-character cap), and 15,743 characters of personal
instruction file, most of it rules that apply only to some work. After this
Plan a session loads the rules that apply always, the Root Hubs and the
current Task; the rest arrives by path, as a skill, or when the agent asks for
it, and the agent keeps its memory without a review by the Operator.

## 1. Private Rule packs

**Done when:** each Memory layer has a Rule pack in the Memory home; `kalfa rule add|change|remove` writes a rule with its checks and commits it; `kalfa install` writes the personal rules and `kalfa build` a project's rules as Instruction files, the project's in a git-ignored folder; a rule loads always, by path or as a skill, and a harness without `path-rules` or `skills` loads it always or as a pointer line; `kalfa doctor` reports a missing or changed file and `kalfa uninstall` removes them; every active rule record of every layer is in its Rule pack, still loading always, and no session report holds rules; local checks pass.

- [x] A layer's Rule pack: a `rules/` folder per layer in the Memory home, in the file format of a Module's Rule pack (Markdown, optional `paths:`), read by the Core.
- [x] `kalfa rule add|change|remove --layer personal|project`: checks the length, the path patterns and the layer, commits in the Memory home and writes the Instruction files again.
- [x] Instruction files: the personal rules under `~/.claude/rules/kalfa-personal/` at `kalfa install` and after each rule write; a project's under `.claude/rules/kalfa-project/` at `kalfa build`; both recorded for `kalfa uninstall`.
- [x] The skill form: a rule that is a procedure is written as a skill of its layer and linked where the harness finds skills.
- [x] Capabilities `path-rules` and `skills`, both declared by the Claude Adapter; without them a path-scoped rule loads always and a skill-form rule becomes a pointer line.
- [x] `kalfa doctor` shows each layer's Rule pack against its Instruction files and warns when the rules that load always pass their count limit.
- [x] Move the rules: `kalfa rule migrate [--dry-run]` writes each active rule record of every layer into its Rule pack with its text unchanged, loading always, and closes the record with a pointer to its file.

## 2. Long-term memory: records, Hubs and links

**Done when:** a Memory record is a fact, a decision, an open item or a Hub, and new writes take no rule type and no `proposed` status; `[[id]]` and `[[personal:id]]` links are read from the body, back-links are found at read time, and `kalfa memory show <id> --depth 1|2` returns the record with its neighbours' summary lines; the write commands live in the memory Module; search ranks Long-term, then Short-term, then archived records, by use within each; the lint reports broken links and a personal record that links into a project; local checks pass.

- [x] The record format: the `hub` type; the `rule` type and the `proposed` status refused for new writes and still read for the migration.
- [ ] Links: parse `[[id]]` and `[[personal:id]]`, find back-links, and `kalfa memory show --depth`.
- [ ] The write commands (`add`, `supersede`, `confirm`, `close`, `show`, `list`) move from the Core to the memory Module; the Core keeps the Memory home.
- [ ] Search ranking in three tiers, by use within each.
- [ ] The lint: broken links, and links from the Personal layer into a project.

## 3. The session start and recall

**Done when:** the session start loads each layer's Root Hub (at most 1,500 characters, a setting), the current Task's Short-term memory, one line for each open Task and Plan and the count of deferred items, and no index lines for a layer that has a Root Hub; the first prompt of a session adds the best few search hits once; every prompt's hits go to the shadow log without being injected; the personal Instruction file holds only rules; the kalfa session report is measured below 5,000 characters; local checks pass.

- [ ] The Root Hubs in the session report, with their limit; a layer without a Root Hub still loads its index lines.
- [x] The deferred items as a count; `/kalfa-status` keeps the full list.
- [ ] First-prompt recall: one search with the prompt and the Task, once per session.
- [ ] The shadow log: each prompt's search hits written to a log in the cache folder, not injected.
- [ ] The personal Instruction file `kalfa-memory.md` retires; the rules come from Part 1's files.

## 4. Short-term memory and the Cleanup

**Done when:** a Section's Keep part replaces Memory candidates; at Task close the agent gets the Cleanup's steps and marks the record reconciled when it is done; kalfa records the Active days of each repository; at Task close every reconciled record outside the window moves with its Checkpoints to the archive in the Memory home; the session start names the closed records that are not reconciled and each Task with no write for seven days; the inbox is gone; local checks pass.

- [ ] The Keep part replaces Memory candidates; the old name is still read.
- [ ] The Cleanup at Task close: the memory Module gives the agent its steps; `kalfa task reconciled [--task <id>]` marks the record.
- [ ] Active days: the day of each session start per repository, beside the commit dates.
- [ ] The window: a closed record stays while its Plan is active, an open Task links to it, or it closed fewer than N Active days ago (N = 5, a setting); otherwise, once reconciled, it moves with its Checkpoints to the archive.
- [ ] Session start lines: the closed records that are not reconciled, and each Task with no write for seven days.
- [ ] The inbox and its Task-close question retire, after Part 5 decides the waiting candidates.

## 5. Migration

**Done when:** `kalfa memory migrate` has run for every repository; each layer has a Root Hub, its subject Hubs and links, every rule has its form, and no proposed record or inbox candidate is left; the managed `/etc/claude-code/CLAUDE.md` names `kalfa rule add` and `kalfa memory add`; `kalfa doctor` shows every repository's session report below the cap; each layer's migration Task lists where each rule went and what it made active or closed.

- [ ] `kalfa memory migrate [--dry-run]`: the existing closed Task Records are marked reconciled, since their candidates went through the old path, and those outside the window move to the archive.
- [ ] The kalfa layer: rule forms, Root Hub, subject Hubs, links, the proposed records and the inbox.
- [ ] The Personal layer, the same way.
- [ ] The infrastructure repository's layer, the same way.
- [ ] The three remaining project layers.
- [ ] The managed instruction text: the agent writes the new text; the Operator puts it in `/etc/claude-code/CLAUDE.md`, which is root's.
- [ ] Prove it live: in each repository one session's report size, and one path-scoped rule that loads only when its file is read.

## 6. Recall on every prompt, from data

**Done when:** after about two weeks of use, the shadow log has been compared with the agent's own searches and reads, and recall on every prompt is either on with a measured score threshold and no repeats in a session, or dropped; the result is written in this Plan.

- [ ] Compare the shadow log with the searches and reads in the transcripts; decide the threshold or drop the push.

## Order

Part 1 first: its last step moves the rules out of the session report, with
every rule still loading. That alone did not bring the infrastructure
repository below the cap: on 2026-11-22, after the move, its report was 11,885
characters, because the list of deferred items took 3,323 of them, where the
Core left 1,700 for the other Modules. Part 3's count of deferred items came
next, ahead of Part 2: with it the infrastructure report measured 7,908
characters. The kalfa report was over the cap for another reason: Task recall
took 1,547 characters of that room, so the room became 2,500, and the report
measured 9,478. Parts 2, 3 and 4 follow in that order, since the session start
needs the Hubs and the Cleanup writes the new records; Part 5 then moves one
layer at a time, and Part 6 waits for two weeks of data.
