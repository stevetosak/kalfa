// The Core's own handlers: the session report (open Plans; open Tasks, or
// after a /clear the Handoff of the branch's Task) and the task-list mapping.
// Standing memory: the Personal layer in every session, and the project's
// layer inside a repository, under their budgets (ADR 0002).
import { currentBranch } from '../core/git.ts';
import { memoryHome, readLayer, sessionLayers } from '../core/memory/home.ts';
import { budgetOf, layerView, overBudgetNotice, renderLayer } from '../core/memory/standing.ts';
import { memoryBudgets, type Settings } from '../core/settings.ts';
import type { HandlerResult } from '../core/events.ts';
import type { ModuleManifest } from '../core/module-source.ts';
import { CORE_MODULE, type Handler, type ModuleDefinition } from '../core/modules.ts';
import { findPlans, isOpenPlan, planSummary } from '../core/plans.ts';
import type { Project } from '../core/project.ts';
import { handoffView, listRecords, taskIdOf } from '../core/task-record.ts';

/** One part of the session report: what the agent reads, and a short summary the Operator sees. */
interface ReportPart {
	context?: string;
	summary?: string;
	notice?: string;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

function planReport(project: Project): ReportPart {
	const globs = project.file?.plans ?? [];
	if (!globs.length) return {};
	const { plans, problems } = findPlans(project.root, globs);
	const open = plans.filter(isOpenPlan);
	return {
		context: open.length ? ['Open Plans in this repository (kalfa plan list):', ...open.map(planSummary)].join('\n') : undefined,
		summary: open.length ? plural(open.length, 'open Plan') : undefined,
		notice: problems.length ? `kalfa: Plans: ${problems.join('; ')}` : undefined,
	};
}

function taskReport(project: Project, source: string | undefined): ReportPart {
	const open = listRecords(project.root).filter((r) => r.header.status === 'open');
	if (!open.length) return {};

	const branch = currentBranch(project.root);
	const own = branch ? open.find((r) => r.id === taskIdOf(branch)) : undefined;
	if (source === 'clear' && own) {
		return { context: `Continue the Task from its record (kalfa task show --handoff):\n\n${handoffView(own)}`, summary: `continuing Task ${own.id} from its Handoff` };
	}

	const lines = open.map((r) => {
		const next = r.sections.at(-1)?.parts.get('Next');
		return `- ${r.id}: ${r.header.goal} (${r.sections.length} Section(s))${next ? `\n  Next: ${next.split('\n')[0]}` : ''}`;
	});
	const hint = 'Record each closed Section with `kalfa section close "<title>"` (parts on stdin); close the Task with `kalfa task close`.';
	const others = open.length - (own ? 1 : 0);
	const summary = [own ? `Task ${own.id} open on this branch (its Handoff comes after /clear)` : undefined, others ? plural(others, own ? 'other open Task' : 'open Task') : undefined]
		.filter(Boolean)
		.join(' · ');
	return { context: [`Open Tasks in this repository (kalfa task show --task <id>):`, ...lines, hint].join('\n'), summary };
}

function memoryReport(project: Project | undefined, settings: Settings, env: NodeJS.ProcessEnv): ReportPart {
	const budgets = memoryBudgets(settings);
	const views = sessionLayers(memoryHome(env), project).map((layer) => layerView(layer, readLayer(layer), budgetOf(layer, budgets)));
	const blocks = views.map(renderLayer).filter(Boolean);
	const notices = views.map((v) => overBudgetNotice(v, budgetOf(v.layer, budgets))).filter(Boolean);
	const rules = views.reduce((n, v) => n + v.rules.length, 0);
	const lines = views.reduce((n, v) => n + v.index.length, 0);
	return {
		context: blocks.length
			? ['Standing memory (kalfa memory). Write a record only through `kalfa memory add|supersede|confirm`; what you find yourself is a Memory candidate first.', ...blocks].join('\n\n')
			: undefined,
		summary: blocks.length ? `memory: ${plural(rules, 'rule')}, ${plural(lines, 'index line')}` : undefined,
		notice: notices.length ? notices.join('\n') : undefined,
	};
}

/**
 * The agent gets the full report; the Operator sees one line of what it
 * holds (harnesses show a notice to the Operator, not the context).
 */
const sessionReport: Handler = (event, { project, settings, env }) => {
	if (event.name !== 'session.start') return undefined;
	const parts = [memoryReport(project, settings, env), ...(project ? [planReport(project), taskReport(project, event.source)] : [])];
	const context = parts.map((p) => p.context).filter(Boolean).join('\n\n');
	const summary = parts.map((p) => p.summary).filter(Boolean).join(' · ');
	const notice = [summary ? `kalfa: ${summary}` : undefined, ...parts.map((p) => p.notice)].filter(Boolean).join('\n');
	if (!context && !notice) return undefined;
	return { context: context || undefined, notice: notice || undefined };
};

/** Without a task list the Section stays in the record only. */
const taskListMapping: Handler = (event, { capabilities }) => {
	if (event.name !== 'section.close' || !capabilities.has('task-list')) return undefined;
	return { context: `Task list: mark the item for "${event.section.title}" completed.` };
};

/** What the Core does on a harness without each Capability; `kalfa doctor` lists it like a Module's `needs`. */
export const coreNeeds: ModuleManifest['needs'] = [
	{ capability: 'context-injection', without: 'no session report; the agent runs kalfa plan list and kalfa task list itself' },
	{ capability: 'task-list', without: 'a closed Section stays in the Task Record only' },
];

export const coreModule: ModuleDefinition = {
	name: CORE_MODULE,
	handlers: { 'session.start': sessionReport, 'section.close': taskListMapping },
};
