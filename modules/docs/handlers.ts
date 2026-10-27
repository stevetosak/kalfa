// The docs Module's code: the Definition of Done gate before a PR is opened,
// and the note at a Task's close that its Log is due. A `Docs: none —
// <reason>` line in the PR body skips the gate on purpose, on record in the PR.
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import type { CoreEvent, HandlerResult } from '../../src/core/events.ts';
import { type ModuleDefinition, moduleSettings } from '../../src/core/modules.ts';
import { loadProject, type Project } from '../../src/core/project.ts';
import { checkBranch, defaultBranch, originRepo } from './gate.ts';
import { docsSkipReason, isPrCreate, parsePrCreate } from './pr-command.ts';

const repoGlob = z
	.string()
	.min(1)
	.refine((glob) => !glob.startsWith('/') && !glob.split('/').includes('..'), 'a glob is relative to the repository root and stays inside it');

const settings = z.strictObject({
	/** Where the Logs are: a changed file under one of these globs is a Log. */
	logs: z.array(repoGlob).min(1).default(['docs/logs/**/*.md']),
	/** The branch PRs merge into, when `gh pr create` does not name one; else the remote's default branch. */
	base: z.string().min(1).optional(),
});

export const docsSettings = (project: Project | undefined): z.infer<typeof settings> => moduleSettings(docsModule, project);

export const HOW_TO_PASS =
	'Write the Log (`kalfa docs draft --out <dir>` drafts it from the Task Record), commit and push it, then retry. To skip on purpose, add a line `Docs: none — <reason>` to the PR body.';

function gate(event: Extract<CoreEvent, { name: 'command.before' }>, project: Project | undefined): HandlerResult | undefined {
	if (!isPrCreate(event.command)) return undefined;
	const pr = parsePrCreate(event.command);
	// A `cd <dir> &&` prefix makes the PR from that directory's repository.
	const dir = resolve(event.cwd, pr.cdDir ?? '.');
	const target = pr.cdDir ? loadProject(dir) : project;
	if (!target?.file?.modules.includes('docs')) return undefined;

	const bodyFile = pr.bodyFile && resolve(dir, pr.bodyFile);
	const skip = docsSkipReason(event.command + (bodyFile && existsSync(bodyFile) ? `\n${readFileSync(bodyFile, 'utf8')}` : ''));
	if (skip) return { notice: `kalfa docs: Definition of Done skipped: ${skip}` };

	const origin = originRepo(dir);
	if (pr.repo && origin?.toLowerCase() !== pr.repo.toLowerCase()) {
		return { notice: `kalfa docs: not checked; --repo ${pr.repo} is not this repository's origin (${origin ?? 'none'}).` };
	}
	try {
		const { logs, base } = docsSettings(target);
		// `--head owner:branch` names a fork's branch; the local name is after the colon.
		const verdict = checkBranch({ dir, logGlobs: logs, base: pr.base ?? base ?? defaultBranch(dir), head: pr.head?.split(':').at(-1) });
		if (verdict.ok) return undefined;
		return { block: `kalfa docs: the Definition of Done is not met (${verdict.range}): ${verdict.problem}. ${HOW_TO_PASS}` };
	} catch (error) {
		// In scope but not judgeable: refuse, and say why. The skip line still works.
		return { block: `kalfa docs could not check this branch: ${(error as Error).message}. ${HOW_TO_PASS}` };
	}
}

export const docsModule = {
	name: 'docs',
	settings,
	filters: { 'command.before': 'gh[[:space:]]+pr[[:space:]]+create' },
	handlers: {
		'command.before'(event, { project }) {
			return event.name === 'command.before' ? gate(event, project) : undefined;
		},
		'task.close'(event, { project }): HandlerResult | undefined {
			if (event.name !== 'task.close') return undefined;
			const { logs } = docsSettings(project);
			return {
				context: `The docs Module: Task ${event.task} needs a Log before its PR, a file under ${logs.join(', ')}. Draft it from the Task Record with \`kalfa docs draft --task ${event.task} --out <dir>\`, edit it, and commit it. When a later reader needs nothing from this work, put \`Docs: none — <reason>\` in the PR body instead.`,
			};
		},
	},
} satisfies ModuleDefinition & { settings: typeof settings };
