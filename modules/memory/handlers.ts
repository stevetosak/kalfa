// The memory Module's code (ADR 0002): recall at session start from the open
// Task, recall on each prompt when a setting turns it on, and at Task close
// the copy of the Task Record into the Memory home and its Memory candidates
// into the inbox, in one commit.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CoreEvent, HandlerResult } from '../../src/core/events.ts';
import { currentBranch } from '../../src/core/git.ts';
import { commitHome, memoryHome, projectKey, projectTasksDir, scanLayer, sessionLayers } from '../../src/core/memory/home.ts';
import { type GateContext, type HandlerContext, type ModuleDefinition, moduleSettings } from '../../src/core/modules.ts';
import type { Project } from '../../src/core/project.ts';
import { memoryBudgets, type Settings } from '../../src/core/settings.ts';
import { CANDIDATES_PART, parseRecord, readRecord, type TaskRecord, taskIdOf } from '../../src/core/task-record.ts';
import { candidateFiles, readInbox, splitCandidates } from './inbox.ts';
import { lint } from './lint.ts';
import { hitLine, openIndex } from './search.ts';
import { type MemorySettings, memorySettings } from './settings.ts';
import type { SourceScope } from './sources.ts';

const today = () => new Date().toLocaleDateString('sv-SE');
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
/** A prompt shorter than this many words gives too little to search with. */
const PROMPT_MIN_WORDS = 3;
const PROMPT_MAX_CHARS = 600;

export const settingsOf = (context: GateContext): MemorySettings => moduleSettings(memoryModule, context.project, context.settings);

export const sourceScope = (project: Project | undefined, settings: MemorySettings, env: NodeJS.ProcessEnv): SourceScope => ({ project, env, archives: settings.archives });

/** The lint over the layers a session in `project` sees. */
export function lintHere(project: Project | undefined, coreSettings: Settings, settings: MemorySettings, env: NodeJS.ProcessEnv) {
	const scans = sessionLayers(memoryHome(env), project).map((layer) => ({ layer, scan: scanLayer(layer) }));
	return lint({ scans, budgets: memoryBudgets(coreSettings), ageLimits: settings['age-limits'], today: today() });
}

/** The open Task of the checked-out branch, the one recall searches for. */
function ownOpenTask(project: Project | undefined): TaskRecord | undefined {
	const branch = project && currentBranch(project.root);
	const record = branch ? readRecord(project.root, taskIdOf(branch)) : undefined;
	return record?.header.status === 'open' ? record : undefined;
}

/** What recall searches with for a Task: its goal and its last Next step. */
export function taskQuery(record: TaskRecord): string {
	const next = record.close?.get('Next') ?? record.sections.at(-1)?.parts.get('Next') ?? '';
	return `${record.header.goal}\n${next}`;
}

interface Part {
	context?: string;
	summary?: string;
	notice?: string;
}

/** One part of the session report; its failure is a notice, and the other parts still run. */
function attempt(name: string, run: () => Part): Part {
	try {
		return run();
	} catch (error) {
		return { notice: `kalfa: memory ${name}: ${(error as Error).message}` };
	}
}

function recallPart(context: HandlerContext, settings: MemorySettings): Part {
	const task = ownOpenTask(context.project);
	if (!task) return {};
	const index = openIndex(sourceScope(context.project, settings, context.env));
	const hits = index.search(taskQuery(task), settings['recall-hits'], (hit) => hit.task !== task.id);
	const notice = index.problems.length ? `kalfa: memory search left out: ${index.problems.join('; ')}` : undefined;
	if (!hits.length) return { notice };
	return {
		context: [`Recall for Task ${task.id} (kalfa memory search "<words>" finds more; read a hit before you rely on it):`, ...hits.map(hitLine)].join('\n'),
		summary: `recall ${plural(hits.length, 'hit')}`,
		notice,
	};
}

function inboxPart(env: NodeJS.ProcessEnv): Part {
	const { candidates, problems } = readInbox(memoryHome(env));
	const notice = problems.length ? `kalfa: memory inbox: ${problems.join('; ')}` : undefined;
	if (!candidates.length) return { notice };
	const count = plural(candidates.length, 'Memory candidate');
	return {
		context: `${count} wait${candidates.length === 1 ? 's' : ''} in the inbox for the Operator's answer (kalfa memory inbox).`,
		summary: `${candidates.length} in the inbox`,
		notice,
	};
}

function lintPart(context: HandlerContext, settings: MemorySettings): Part {
	const findings = lintHere(context.project, context.settings, settings, context.env);
	return findings.length ? { notice: `kalfa: memory lint: ${plural(findings.length, 'finding')} (kalfa memory lint)` } : {};
}

function sessionStart(event: CoreEvent, context: HandlerContext): HandlerResult | undefined {
	if (event.name !== 'session.start' || event.subagent) return undefined;
	const settings = settingsOf(context);
	const parts = [attempt('recall', () => recallPart(context, settings)), attempt('inbox', () => inboxPart(context.env)), attempt('lint', () => lintPart(context, settings))];
	const context_ = parts.map((p) => p.context).filter(Boolean).join('\n\n');
	const summary = parts.map((p) => p.summary).filter(Boolean).join(' · ');
	const notice = [summary ? `kalfa: memory: ${summary}` : undefined, ...parts.map((p) => p.notice)].filter(Boolean).join('\n');
	if (!context_ && !notice) return undefined;
	return { context: context_ || undefined, notice: notice || undefined };
}

function promptSubmit(event: CoreEvent, context: HandlerContext): HandlerResult | undefined {
	if (event.name !== 'prompt.submit' || event.subagent) return undefined;
	const prompt = event.prompt.trim();
	if (prompt.startsWith('/') || prompt.split(/\s+/).length < PROMPT_MIN_WORDS) return undefined;
	const settings = settingsOf(context);
	const hits = openIndex(sourceScope(context.project, settings, context.env)).search(prompt.slice(0, PROMPT_MAX_CHARS), settings['recall-hits']);
	if (!hits.length) return undefined;
	return { context: ['Recall for this prompt (kalfa memory search; read a hit before you rely on it):', ...hits.map(hitLine)].join('\n') };
}

/** The question the agent puts to the Operator at Task close. */
export function candidateQuestion(task: string, ids: readonly { id: string; candidate: string }[]): string {
	return [
		`Task ${task} left ${plural(ids.length, 'Memory candidate')} in the inbox. Ask the Operator ONE question that lists each candidate with the type (rule, fact, decision, open) and the layer (personal, project) you propose, and a one-line summary.`,
		'For each answer run `kalfa memory inbox accept <id> --type <type> --layer <layer> --summary "<one line>"` (a body on stdin, optional) or `kalfa memory inbox reject <id> "<reason>"`. A candidate the Operator does not answer stays in the inbox.',
		...ids.map(({ id, candidate }) => `- ${id}: ${candidate.replace(/\s*\n\s*/g, ' ')}`),
	].join('\n');
}

function taskClose(event: CoreEvent, context: HandlerContext): HandlerResult | undefined {
	if (event.name !== 'task.close' || !context.project) return undefined;
	const project = context.project;
	const home = memoryHome(context.env);
	const text = readFileSync(event.record, 'utf8');
	const record = parseRecord(text, event.record, event.task);
	const parts = [...record.sections.map((s) => s.parts), ...(record.close ? [record.close] : [])];
	const texts = parts.flatMap((p) => splitCandidates(p.get(CANDIDATES_PART) ?? ''));
	const key = projectKey(project.root);
	const inbox = candidateFiles(home, { project: key, task: record.id, created: today() }, texts);
	const copy = join(projectTasksDir(home, project), `${record.id}.md`);
	commitHome(
		home,
		{ write: [{ path: copy, text }, ...inbox.map(({ path, text: body }) => ({ path, text: body }))] },
		`close task ${record.id} (${key}): copy the record${inbox.length ? `, ${plural(inbox.length, 'candidate')} to the inbox` : ''}`,
	);
	const notice = `kalfa: memory: Task Record copied to the Memory home${inbox.length ? `; ${plural(inbox.length, 'Memory candidate')} in the inbox` : ''}`;
	return inbox.length ? { context: candidateQuestion(record.id, inbox), notice } : { notice };
}

export const memoryModule = {
	name: 'memory',
	settings: memorySettings,
	when: { 'prompt.submit': (context) => settingsOf(context)['recall-on-prompt'] },
	handlers: { 'session.start': sessionStart, 'prompt.submit': promptSubmit, 'task.close': taskClose },
} satisfies ModuleDefinition & { settings: typeof memorySettings };
