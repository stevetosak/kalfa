// The Core's own handlers: the session report (open Plans; open Tasks, or the
// branch's Task after /clear, /compact or a fork), the continue word and the
// task-list mapping. After /clear the Operator sees the Task's brief, and the
// Handoff loads only when the first prompt is a continue word: any other
// prompt starts a new task without it. After /compact or a fork the session
// goes on with the Task, so the Handoff loads at once.
// Before a compaction (the Operator's /compact, or the harness's own near the
// limit or after idle time) the summary is told what the branch's Task needs;
// after it, the summary is kept as the Task's Checkpoint.
// After some days with no activity in the repository, a new session starts
// with the Recap instead of the list of open Tasks.
// Standing memory: the Personal layer in every session, and the project's
// layer inside a repository: the Loaded tier under their budgets, and a line
// for the Stored tier (ADR 0002). Where the harness loads kalfa's instruction
// file, the Personal layer comes from it instead, and the report is fitted
// under the Adapter's cap on one hook's context (amendment 2026-11-12).
import { statSync } from 'node:fs';
import { writeCheckpoint } from '../core/checkpoint.ts';
import { currentBranch } from '../core/git.ts';
import { type Layer, type LayerScan, memoryHome, scanLayer, sessionLayers } from '../core/memory/home.ts';
import { refreshInstructions } from '../core/memory/instructions.ts';
import { budgetOf, type LayerView, layerView, overBudgetNotice, renderLayer } from '../core/memory/standing.ts';
import { readUsage } from '../core/memory/usage.ts';
import { lastActivity, idleDays, markSession, recapTask, recapView } from '../core/recap.ts';
import { type MemoryBudgets, memoryBudgets, recapAfterDays, type Settings } from '../core/settings.ts';
import { isContinueWord } from '../core/continue-word.ts';
import type { CoreEvent, HandlerResult, SessionStartSource } from '../core/events.ts';
import type { ModuleManifest } from '../core/module-source.ts';
import { CORE_MODULE, type Handler, type ModuleDefinition } from '../core/modules.ts';
import { findPlans, isOpenPlan, planSummary } from '../core/plans.ts';
import type { Project } from '../core/project.ts';
import { briefView, compactFocus, handoffView, listRecords, nextStep, readRecord, type TaskRecord, taskIdOf } from '../core/task-record.ts';
import { setWake, takeWake } from '../core/wake.ts';

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

/** Characters of the hook's context the session report leaves for the other Modules (recall, deferred items). */
const OTHER_MODULES_ROOM = 1500;

/** Open Tasks other than the branch's that the session report names, the most recently written first. */
const OTHER_TASKS_SHOWN = 3;

/** After these the session goes on with the work it had, so the Handoff loads at once. */
const RELOAD_SOURCES: ReadonlySet<SessionStartSource> = new Set(['compact', 'fork']);

const handoffContext = (record: TaskRecord) => `Continue the Task from its record (kalfa task show --handoff):\n\n${handoffView(record)}`;

/** After /clear: the brief for the Operator, a pointer for the agent, and a wake for the first prompt. */
function clearReport(project: Project, own: TaskRecord, session: string | undefined): ReportPart {
	setWake(project.root, 'prompt.submit', { session, data: { task: own.id } });
	return {
		context: [
			`Task ${own.id} is open on this branch; the Operator sees its brief.`,
			`If the first prompt is a continue word, the Task's Handoff comes with it. Any other first prompt is a new task: read the Handoff (kalfa task show --handoff) only when the prompt is about Task ${own.id}.`,
		].join(' '),
		notice: `kalfa: ${briefView(own)}\nType "continue" to load its Handoff, or give a new task.`,
	};
}

function taskReport(project: Project, event: Extract<CoreEvent, { name: 'session.start' }>): ReportPart {
	const open = listRecords(project.root).filter((r) => r.header.status === 'open');
	if (!open.length) return {};

	const branch = currentBranch(project.root);
	const own = branch ? open.find((r) => r.id === taskIdOf(branch)) : undefined;
	if (own && event.source === 'clear') return clearReport(project, own, event.sessionId);
	if (own && RELOAD_SOURCES.has(event.source)) return { context: handoffContext(own), summary: `Handoff of Task ${own.id} loaded again` };

	// The branch's Task in full; of the others only the most recently written, in one line each.
	const others = open.filter((r) => r !== own).sort((a, b) => statSync(b.path).mtimeMs - statSync(a.path).mtimeMs);
	const shown = others.slice(0, OTHER_TASKS_SHOWN);
	const lines = [
		...(own ? [`- ${own.id}: ${own.header.goal} (${own.sections.length} Section(s))${own.header['done-when'] ? `\n  Done when: ${own.header['done-when']}` : ''}${nextStep(own) ? `\n  Next: ${nextStep(own)}` : ''}`] : []),
		...shown.map((r) => `- ${r.id}: ${r.header.goal}${nextStep(r) ? `\n  Next: ${nextStep(r)}` : ''}`),
		...(others.length > shown.length ? [`- … and ${others.length - shown.length} more open (kalfa task list)`] : []),
	];
	const hint = 'Record each closed Section with `kalfa section close "<title>"` (parts on stdin); close the Task with `kalfa task close` once its Done when line holds.';
	const summary = [own ? `Task ${own.id} open on this branch (after /clear, "continue" loads its Handoff)` : undefined, others.length ? plural(others.length, own ? 'other open Task' : 'open Task') : undefined]
		.filter(Boolean)
		.join(' · ');
	return { context: [`Open Tasks in this repository (kalfa task show --task <id>):`, ...lines, hint].join('\n'), summary };
}

/**
 * A new session after `recap.after-days` days without activity: the agent
 * gets the Recap and tells it before other work; the Operator sees the brief.
 * Every new session counts as activity, so the Recap shows once per absence.
 */
function recapReport(project: Project, settings: Settings, event: Extract<CoreEvent, { name: 'session.start' }>): ReportPart | undefined {
	if (event.source !== 'startup') return undefined;
	const since = lastActivity(project.root);
	markSession(project.root);
	const now = new Date();
	const days = since ? idleDays(since, now) : 0;
	const record = recapTask(project.root);
	if (days < recapAfterDays(settings) || !record) return undefined;
	return {
		context: [
			`The Operator comes back to this repository after ${plural(days, 'day')} without activity. Before other work, tell the Operator in a few sentences where the work stood, why (the Decisions) and the next step, as /where-was-i does; read the last Checkpoint when the record does not tell enough. The Recap (kalfa recap):`,
			recapView(project.root, project.file?.plans ?? [], { now }),
		].join('\n\n'),
		summary: `Recap after ${plural(days, 'day')} away`,
		notice: `kalfa: ${plural(days, 'day')} since the last activity here.\n${briefView(record)}\n/where-was-i tells the line of thinking.`,
	};
}

const MEMORY_HEADER = 'Standing memory (kalfa memory). Write a record only through `kalfa memory add|supersede|confirm`; what you find yourself is a Memory candidate first.';
/** What a layer's index heading costs, with the blank line before it. */
const INDEX_HEADING = 'Index (the body: kalfa memory show <id>):'.length + 3;

/**
 * The layers' views. Within `room` characters the rules and the Stored line
 * always load, and the index lines fill what is left, in layer order, each
 * layer still under its own budget.
 */
function fitViews(scans: { layer: Layer; scan: LayerScan }[], budgets: MemoryBudgets, env: NodeJS.ProcessEnv, room: number | undefined): LayerView[] {
	const viewOf = (layer: Layer, records: LayerScan['records'], indexBytes?: number) => {
		const budget = budgetOf(layer, budgets);
		return layerView(layer, records, indexBytes === undefined ? budget : { ...budget, 'index-bytes': Math.max(0, Math.min(budget['index-bytes'], indexBytes)) }, readUsage(layer, env));
	};
	if (room === undefined) return scans.map(({ layer, scan }) => viewOf(layer, scan.records));
	const fixed = scans.reduce((sum, { layer, scan }) => sum + renderLayer(viewOf(layer, scan.records, 0)).length + 2 + INDEX_HEADING, 0);
	let left = room - MEMORY_HEADER.length - fixed;
	return scans.map(({ layer, scan }) => {
		const view = viewOf(layer, scan.records, left);
		left -= view.indexBytes;
		return view;
	});
}

/**
 * Standing memory for the session report. `personal: false` leaves out the
 * Personal layer, which the instruction file loads; `room` is the most
 * characters it may take.
 */
function memoryReport(project: Project | undefined, settings: Settings, env: NodeJS.ProcessEnv, fit: { personal: boolean; room?: number }): ReportPart {
	const budgets = memoryBudgets(settings);
	const layers = sessionLayers(memoryHome(env), project).filter((layer) => fit.personal || layer.name !== 'personal');
	const scans = layers.map((layer) => ({ layer, scan: scanLayer(layer) }));
	const views = fitViews(scans, budgets, env, fit.room);
	const blocks = views.map(renderLayer).filter(Boolean);
	// A broken file is left out and named; the other records still load.
	const unreadable = scans.flatMap(({ scan }) => scan.problems.map((p) => `kalfa: memory: left out: ${p}`));
	const notices = [...views.map((v) => overBudgetNotice(v, budgetOf(v.layer, budgets))).filter(Boolean), ...unreadable];
	const rules = views.reduce((n, v) => n + v.rules.length, 0);
	const lines = views.reduce((n, v) => n + v.index.length, 0);
	const stored = views.reduce((n, v) => n + v.stored.length, 0);
	const file = fit.personal ? '' : ' (+ the Personal layer from the instruction file)';
	return {
		context: blocks.length ? [MEMORY_HEADER, ...blocks].join('\n\n') : undefined,
		summary: blocks.length || file ? `memory: ${plural(rules, 'rule')}, ${plural(lines, 'index line')}${stored ? `, ${stored} Stored` : ''}${file}` : undefined,
		notice: notices.length ? notices.join('\n') : undefined,
	};
}

/**
 * The agent gets the full report; the Operator sees one line of what it
 * holds (harnesses show a notice to the Operator, not the context).
 */
const sessionReport: Handler = (event, { project, settings, env, capabilities, contextCap }) => {
	if (event.name !== 'session.start') return undefined;
	// The Personal layer loads from the instruction file when it is current.
	const personal = !(capabilities.has('instruction-file') && refreshInstructions(env, settings, event.harness).length);
	// The Recap comes first: a harness can show only the start of a long report.
	const recap = project ? recapReport(project, settings, event) : undefined;
	const rest = recap ? [recap, planReport(project!)] : project ? [planReport(project), taskReport(project, event)] : [];
	const used = rest.reduce((sum, part) => sum + (part.context ? part.context.length + 2 : 0), 0);
	const memory = memoryReport(project, settings, env, { personal, room: contextCap === undefined ? undefined : contextCap - OTHER_MODULES_ROOM - used });
	const parts = recap ? [recap, memory, rest[1]!] : [memory, ...rest];
	const context = parts.map((p) => p.context).filter(Boolean).join('\n\n');
	const summary = parts.map((p) => p.summary).filter(Boolean).join(' · ');
	const notice = [summary ? `kalfa: ${summary}` : undefined, ...parts.map((p) => p.notice)].filter(Boolean).join('\n');
	if (!context && !notice) return undefined;
	return { context: context || undefined, notice: notice || undefined };
};

/**
 * The first prompt after /clear (the wake from clearReport): a continue word
 * loads the Handoff of the Task; any other prompt only uses up the wake.
 */
const continueWord: Handler = (event, { project }) => {
	if (event.name !== 'prompt.submit' || event.subagent || !project) return undefined;
	const task = takeWake(project.root, 'prompt.submit', event.sessionId)?.data.task;
	if (!task || !isContinueWord(event.prompt)) return undefined;
	const record = readRecord(project.root, task);
	if (record?.header.status !== 'open') return undefined;
	return { context: `The Operator continues Task ${task}. ${handoffContext(record)}`, notice: `kalfa: Handoff of Task ${task} loaded` };
};

/** The open Task of the branch checked out at `root`. */
function branchTask(root: string): TaskRecord | undefined {
	const branch = currentBranch(root);
	const record = branch ? readRecord(root, taskIdOf(branch)) : undefined;
	return record?.header.status === 'open' ? record : undefined;
}

/** What the summary must keep for the branch's Task. A subagent's compaction is its own. */
const compactBefore: Handler = (event, { project }) => {
	if (event.name !== 'compact.before' || event.subagent || !project) return undefined;
	const own = branchTask(project.root);
	return own ? { context: compactFocus(own) } : undefined;
};

/** The summary becomes the Task's newest Checkpoint. */
const compactAfter: Handler = (event, { project }) => {
	if (event.name !== 'compact.after' || event.subagent || !project || !event.summary.trim()) return undefined;
	const own = branchTask(project.root);
	if (!own) return undefined;
	const path = writeCheckpoint(project.root, { task: own.id, trigger: event.trigger, at: new Date().toISOString(), session: event.sessionId, summary: event.summary });
	return { notice: `kalfa: checkpoint of Task ${own.id} saved (${event.trigger} compaction): ${path}` };
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
	{ capability: 'compaction', without: "a compaction keeps what the harness chooses, and the Task gets no Checkpoint" },
];

export const coreModule: ModuleDefinition = {
	name: CORE_MODULE,
	handlers: { 'session.start': sessionReport, 'prompt.submit': continueWord, 'compact.before': compactBefore, 'compact.after': compactAfter, 'section.close': taskListMapping },
	wakeOnly: ['prompt.submit'],
};
