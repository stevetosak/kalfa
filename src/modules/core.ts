// The Core's own handlers: the session report (open Plans; open Tasks, or
// after a /clear the Handoff of the branch's Task) and the task-list mapping.
// A later section adds memory budgets to the report.
import { currentBranch } from '../core/git.ts';
import type { HandlerResult } from '../core/events.ts';
import { CORE_MODULE, type Handler, type ModuleDefinition } from '../core/modules.ts';
import { findPlans, isOpenPlan, planSummary } from '../core/plans.ts';
import type { Project } from '../core/project.ts';
import { handoffView, listRecords, taskIdOf } from '../core/task-record.ts';

function planReport(project: Project): HandlerResult {
	const globs = project.file?.plans ?? [];
	if (!globs.length) return {};
	const { plans, problems } = findPlans(project.root, globs);
	const open = plans.filter(isOpenPlan);
	return {
		context: open.length ? ['Open Plans in this repository (kalfa plan list):', ...open.map(planSummary)].join('\n') : undefined,
		notice: problems.length ? `kalfa: Plans: ${problems.join('; ')}` : undefined,
	};
}

function taskReport(project: Project, source: string | undefined): string | undefined {
	const open = listRecords(project.root).filter((r) => r.header.status === 'open');
	if (!open.length) return undefined;

	const branch = currentBranch(project.root);
	const own = branch ? open.find((r) => r.id === taskIdOf(branch)) : undefined;
	if (source === 'clear' && own) return `Continue the Task from its record (kalfa task show --handoff):\n\n${handoffView(own)}`;

	const lines = open.map((r) => {
		const next = r.sections.at(-1)?.parts.get('Next');
		return `- ${r.id}: ${r.header.goal} (${r.sections.length} Section(s))${next ? `\n  Next: ${next.split('\n')[0]}` : ''}`;
	});
	const hint = 'Record each closed Section with `kalfa section close "<title>"` (parts on stdin); close the Task with `kalfa task close`.';
	return [`Open Tasks in this repository (kalfa task show --task <id>):`, ...lines, hint].join('\n');
}

const sessionReport: Handler = (event, { project }) => {
	if (event.name !== 'session.start' || !project) return undefined;
	const plans = planReport(project);
	const context = [plans.context, taskReport(project, event.source)].filter(Boolean).join('\n\n');
	if (!context && !plans.notice) return undefined;
	return { context: context || undefined, notice: plans.notice };
};

/** Without a task list the Section stays in the record only. */
const taskListMapping: Handler = (event, { capabilities }) => {
	if (event.name !== 'section.close' || !capabilities.has('task-list')) return undefined;
	return { context: `Task list: mark the item for "${event.section.title}" completed.` };
};

export const coreModule: ModuleDefinition = {
	name: CORE_MODULE,
	handlers: { 'session.start': sessionReport, 'section.close': taskListMapping },
};
