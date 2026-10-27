// The Core's own handlers: the session report (open Tasks; after a /clear, the
// Handoff of the branch's Task) and the task-list mapping. Later sections add
// Plans and memory budgets to the report.
import { currentBranch } from '../core/git.ts';
import { CORE_MODULE, type Handler, type ModuleDefinition } from '../core/modules.ts';
import { handoffView, listRecords, taskIdOf } from '../core/task-record.ts';

const sessionReport: Handler = (event, { project }) => {
	if (event.name !== 'session.start' || !project) return undefined;
	const open = listRecords(project.root).filter((r) => r.header.status === 'open');
	if (!open.length) return undefined;

	const branch = currentBranch(project.root);
	const own = branch ? open.find((r) => r.id === taskIdOf(branch)) : undefined;
	if (event.source === 'clear' && own) return { context: `Continue the Task from its record (kalfa task show --handoff):\n\n${handoffView(own)}` };

	const lines = open.map((r) => {
		const next = r.sections.at(-1)?.parts.get('Next');
		return `- ${r.id}: ${r.header.goal} (${r.sections.length} Section(s))${next ? `\n  Next: ${next.split('\n')[0]}` : ''}`;
	});
	const hint = 'Record each closed Section with `kalfa section close "<title>"` (parts on stdin); close the Task with `kalfa task close`.';
	return { context: [`Open Tasks in this repository (kalfa task show --task <id>):`, ...lines, hint].join('\n') };
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
