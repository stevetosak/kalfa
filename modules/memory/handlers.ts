// The memory Module's code (ADR 0002, 0003): each layer's Root Hub at
// session start, recall on the first prompt of a session with the prompt and
// the branch's Task (and on each prompt when a setting turns it on), the
// shadow log of each prompt's hits when a setting turns it on, and at
// Task close the copy of the Task Record into the Memory home and its Memory
// candidates into the inbox, in one commit, plus the upkeep proposals for a
// layer over its budget.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CoreEvent, HandlerResult, SessionStartSource } from '../../src/core/events.ts';
import { currentBranch } from '../../src/core/git.ts';
import { commitHome, memoryHome, projectKey, projectTasksDir, scanLayer, sessionLayers } from '../../src/core/memory/home.ts';
import { type GateContext, type HandlerContext, type ModuleDefinition, moduleSettings } from '../../src/core/modules.ts';
import type { Project } from '../../src/core/project.ts';
import { memoryBudgets, type Settings } from '../../src/core/settings.ts';
import { parseRecord, REMEMBER_PART, readRecord, type TaskRecord, taskIdOf } from '../../src/core/task-record.ts';
import { budgetProblem } from '../../src/core/memory/standing.ts';
import { candidateFiles, readInbox, splitCandidates } from './inbox.ts';
import { duplicateFindings, type Finding, findingLine, lint } from './lint.ts';
import { rootHubOf } from '../../src/core/memory/root-hub.ts';
import { rootHubText } from './root-hubs.ts';
import { type Hit, hitLine, openIndex, type SearchIndex } from './search.ts';
import { type MemorySettings, memorySettings } from './settings.ts';
import { appendShadow, shadowEntry } from './shadow.ts';
import type { SourceScope } from './sources.ts';

const today = () => new Date().toLocaleDateString('sv-SE');
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
/** A prompt shorter than this many words gives too little to search with. */
const PROMPT_MIN_WORDS = 3;
const PROMPT_MAX_CHARS = 600;
/**
 * The session starts after which the next prompt recalls: a new conversation,
 * or one the harness summarised. A resumed or forked one still holds its recall.
 */
const RECALL_SOURCES: ReadonlySet<SessionStartSource> = new Set(['startup', 'clear', 'compact']);

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

/** Each layer's Root Hub, the Personal one first, cut at its limit; the Core left out these layers' index lines. */
function rootHubsPart(context: HandlerContext): Part {
	const limit = memoryBudgets(context.settings).rootHubChars;
	const hubs = sessionLayers(memoryHome(context.env), context.project).flatMap((layer) => {
		const hub = rootHubText(layer, scanLayer(layer).records, limit);
		return hub ? [hub] : [];
	});
	if (!hubs.length) return {};
	const cut = hubs.filter((h) => h.cut);
	return {
		context: hubs.map((h) => h.text).join('\n\n'),
		summary: `${plural(hubs.length, 'Root Hub')} (${hubs.map((h) => h.layer.label).join(', ')})`,
		notice: cut.length
			? cut.map((h) => `kalfa: memory: the Root Hub of ${h.layer.label} is ${h.chars} characters, over its limit of ${limit}; it loads cut (kalfa memory lint)`).join('\n')
			: undefined,
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
	const parts = [
		attempt('Root Hubs', () => rootHubsPart(context)),
		attempt('inbox', () => inboxPart(context.env)),
		attempt('lint', () => lintPart(context, settings)),
	];
	const context_ = parts.map((p) => p.context).filter(Boolean).join('\n\n');
	const summary = parts.map((p) => p.summary).filter(Boolean).join(' · ');
	const notice = [summary ? `kalfa: memory: ${summary}` : undefined, ...parts.map((p) => p.notice)].filter(Boolean).join('\n');
	// The session start has no prompt to search with, so the first prompt recalls.
	const wake: HandlerResult['wake'] = RECALL_SOURCES.has(event.source) ? { event: 'prompt.submit' } : undefined;
	if (!context_ && !notice && !wake) return undefined;
	return { context: context_ || undefined, notice: notice || undefined, ...(wake && { wake }) };
}

/** What separates the words of a prompt: the whitespace the shim's filter can see in the raw payload. */
const WORD_GAP = /[ \t\n\r]+/;

const wordCount = (prompt: string) => {
	const text = prompt.trim();
	return text ? text.split(WORD_GAP).length : 0;
};

/** What a prompt gives to search with: nothing for a slash command or a prompt of a word or two. */
export function promptWords(prompt: string): string {
	const text = prompt.trim();
	return text.startsWith('/') || wordCount(text) < PROMPT_MIN_WORDS ? '' : text.slice(0, PROMPT_MAX_CHARS);
}

// The shim's filter for `prompt.submit` (a POSIX extended regex over the raw
// JSON payload): a prompt `promptWords` keeps, at least three words and no
// slash first. In the payload a newline, tab or return is an escape, and `\\`
// and `\"` are one character each. It matches every prompt `promptWords`
// keeps; a prompt it matches in vain only starts Node.
const GAP = String.raw`( |\\[tnr])`;
const CHAR = String.raw`(\\.|[^"\\])`;
const WORD = String.raw`([^"\\ ]|\\[^tnr])`;
const FIRST = String.raw`([^"\\ /]|\\[^tnr])`;
export const SEARCHABLE_PROMPT = `"prompt"[[:space:]]*:[[:space:]]*"${GAP}*${FIRST}${CHAR}*${GAP}${WORD}${CHAR}*${GAP}${WORD}`;

/** The Root Hubs the session start loaded, as `<layer label> <id>`; a hit on one adds nothing. */
function rootHubKeys(project: Project | undefined, env: NodeJS.ProcessEnv): Set<string> {
	return new Set(
		sessionLayers(memoryHome(env), project).flatMap((layer) => {
			const hub = rootHubOf(scanLayer(layer).records);
			return hub ? [`${layer.label} ${hub.id}`] : [];
		}),
	);
}

const searchNotice = (problems: readonly string[]) => (problems.length ? `kalfa: memory search left out: ${problems.join('; ')}` : undefined);

/** One prompt's search: its words, the branch's Task, what the session already holds, and the index, opened once on first use. */
interface PromptScope {
	prompt: string;
	words: string;
	task?: TaskRecord;
	/** The Task's own record and the Root Hubs the session start loaded. */
	held: (hit: Hit) => boolean;
	index: () => SearchIndex;
}

function promptScope(prompt: string, context: HandlerContext, settings: MemorySettings): PromptScope {
	const task = ownOpenTask(context.project);
	let hubs: Set<string> | undefined;
	let index: SearchIndex | undefined;
	return {
		prompt,
		words: promptWords(prompt),
		task,
		held: (hit) =>
			(task !== undefined && hit.task === task.id) || (hit.record !== undefined && (hubs ??= rootHubKeys(context.project, context.env)).has(`${hit.record.layer} ${hit.record.id}`)),
		index: () => (index ??= openIndex(sourceScope(context.project, settings, context.env))),
	};
}

/** What recall gives the prompt, and the hits it injected. */
interface Recall {
	result?: HandlerResult;
	injected: readonly Hit[];
}

const NO_RECALL: Recall = { injected: [] };

/**
 * The first prompt of a session (the wake from the session start): one search
 * with the prompt and the branch's Task, the relevant hits only, without the
 * Task's own record and the Root Hubs the session already holds. A slash
 * command, or a short prompt on a branch without a Task, gives nothing to
 * search with and keeps the wake for the next prompt.
 */
function firstPromptRecall(scope: PromptScope, settings: MemorySettings): Recall {
	const { words, task } = scope;
	if (scope.prompt.trim().startsWith('/') || (!words && !task)) return { result: { wake: { event: 'prompt.submit' } }, injected: [] };
	const index = scope.index();
	const query = [words, ...(task ? [taskQuery(task)] : [])].filter(Boolean).join('\n');
	const hits = index.search(query, settings['recall-hits'], { keep: (hit) => !scope.held(hit), relevantOnly: true });
	const problems = searchNotice(index.problems);
	if (!hits.length) return { result: problems ? { notice: problems } : {}, injected: [] };
	return {
		result: {
			context: [`Recall for this prompt${task ? ` and Task ${task.id}` : ''} (kalfa memory search "<words>" finds more; read a hit before you rely on it):`, ...hits.map(hitLine)].join('\n'),
			notice: [`kalfa: memory: recall ${plural(hits.length, 'hit')}`, problems].filter(Boolean).join('\n'),
		},
		injected: hits,
	};
}

/** Recall on each prompt, when the setting turns it on: the prompt alone. */
function promptRecall(scope: PromptScope, settings: MemorySettings): Recall {
	if (!scope.words) return NO_RECALL;
	const hits = scope.index().search(scope.words, settings['recall-hits']);
	if (!hits.length) return NO_RECALL;
	return { result: { context: ['Recall for this prompt (kalfa memory search; read a hit before you rely on it):', ...hits.map(hitLine)].join('\n') }, injected: hits };
}

/**
 * The prompt's line in the shadow log: every hit of its own words, and what
 * recall injected. A prompt with no words to search and no recall writes none.
 * A failure is a notice; the prompt goes on.
 */
function writeShadow(scope: PromptScope, recall: Recall, first: boolean, session: string | undefined, context: HandlerContext): string | undefined {
	if (!scope.words && !recall.injected.length) return undefined;
	try {
		const at = new Date();
		const hits = scope.words ? scope.index().search(scope.words, Number.POSITIVE_INFINITY) : [];
		const project = context.project && projectKey(context.project.root);
		const entry = shadowEntry({ at, session, project, task: scope.task?.id, first, prompt: scope.prompt, words: wordCount(scope.prompt), hits, held: scope.held, injected: recall.injected });
		appendShadow(context.env, at, entry);
		return undefined;
	} catch (error) {
		return `kalfa: memory shadow log: ${(error as Error).message}`;
	}
}

function promptSubmit(event: CoreEvent, context: HandlerContext): HandlerResult | undefined {
	if (event.name !== 'prompt.submit' || event.subagent) return undefined;
	const settings = settingsOf(context);
	const scope = promptScope(event.prompt, context, settings);
	const first = Boolean(context.wake);
	const recall = first ? firstPromptRecall(scope, settings) : settings['recall-on-prompt'] ? promptRecall(scope, settings) : NO_RECALL;
	const problem = settings['shadow-log'] ? writeShadow(scope, recall, first, event.sessionId, context) : undefined;
	if (!problem) return recall.result;
	return { ...recall.result, notice: [recall.result?.notice, problem].filter(Boolean).join('\n') };
}

/** The question the agent puts to the Operator at Task close. */
export function candidateQuestion(task: string, ids: readonly { id: string; candidate: string }[]): string {
	return [
		`Task ${task} left ${plural(ids.length, 'Memory candidate')} in the inbox. Ask the Operator ONE question that lists each candidate with the type (rule, fact, decision, open) and the layer (personal, project) you propose, and a one-line summary.`,
		'For each answer run `kalfa memory inbox accept <id> --type <type> --layer <layer> --summary "<one line>"` (a body on stdin, optional) or `kalfa memory inbox reject <id> "<reason>"`. A candidate the Operator does not answer stays in the inbox.',
		...ids.map(({ id, candidate }) => `- ${id}: ${candidate.replace(/\s*\n\s*/g, ' ')}`),
	].join('\n');
}

/** What the agent proposes for one layer over its budget at Task close. */
export interface Upkeep {
	layer: string;
	/** How far over its budget the layer is. */
	problem: string;
	duplicates: Finding[];
	/** The layer's active open items, for the agent to say which are finished. */
	open: { id: string; summary: string }[];
}

/** The upkeep of every layer a session here sees that is over its budget (ADR 0002, amendment 2026-11-08). */
export function upkeepHere(project: Project | undefined, coreSettings: Settings, env: NodeJS.ProcessEnv): Upkeep[] {
	const scans = sessionLayers(memoryHome(env), project).map((layer) => ({ layer, scan: scanLayer(layer) }));
	const duplicates = duplicateFindings({ scans });
	return scans.flatMap(({ layer, scan }) => {
		const problem = budgetProblem(layer, scan.records, memoryBudgets(coreSettings));
		if (!problem) return [];
		const open = scan.records.filter((r) => r.header.status === 'active' && r.header.type === 'open').map((r) => ({ id: r.id, summary: r.header.summary }));
		return [{ layer: layer.label, problem, duplicates: duplicates.filter((f) => f.layer === layer.label), open }];
	});
}

/** The upkeep part of the Task-close question; it goes into the same one question as the Memory candidates. */
export function upkeepQuestion(upkeep: readonly Upkeep[]): string {
	return [
		'Memory upkeep: a layer below is over its budget, so some of its records are Stored and do not load. Put proposals in the same ONE question to the Operator: merge each likely duplicate (`kalfa memory supersede`), and close each open item whose work you can show is done (`kalfa memory close <id> "<reason>"`). Act only on the Operator\'s yes; no work waits on the answer.',
		...upkeep.flatMap((u) => [
			`- ${u.problem}`,
			...u.duplicates.map((f) => `  ${findingLine(f)}`),
			...u.open.map((o) => `  - open item ${u.layer}/${o.id}: ${o.summary}`),
		]),
	].join('\n');
}

function taskClose(event: CoreEvent, context: HandlerContext): HandlerResult | undefined {
	if (event.name !== 'task.close' || !context.project) return undefined;
	const project = context.project;
	const home = memoryHome(context.env);
	const text = readFileSync(event.record, 'utf8');
	const record = parseRecord(text, event.record, event.task);
	const parts = [...record.sections.map((s) => s.parts), ...(record.close ? [record.close] : [])];
	const texts = parts.flatMap((p) => splitCandidates(p.get(REMEMBER_PART) ?? ''));
	const key = projectKey(project.root);
	const inbox = candidateFiles(home, { project: key, task: record.id, created: today() }, texts);
	const copy = join(projectTasksDir(home, project), `${record.id}.md`);
	commitHome(
		home,
		{ write: [{ path: copy, text }, ...inbox.map(({ path, text: body }) => ({ path, text: body }))] },
		`close task ${record.id} (${key}): copy the record${inbox.length ? `, ${plural(inbox.length, 'candidate')} to the inbox` : ''}`,
	);
	const upkeep = upkeepHere(project, context.settings, context.env);
	const notice = [
		`kalfa: memory: Task Record copied to the Memory home${inbox.length ? `; ${plural(inbox.length, 'Memory candidate')} in the inbox` : ''}`,
		...(upkeep.length ? [`kalfa: memory: upkeep proposed for ${upkeep.map((u) => u.layer).join(', ')} (over budget)`] : []),
	].join('\n');
	const questions = [...(inbox.length ? [candidateQuestion(record.id, inbox)] : []), ...(upkeep.length ? [upkeepQuestion(upkeep)] : [])];
	return questions.length ? { context: questions.join('\n\n'), notice } : { notice };
}

export const memoryModule = {
	name: 'memory',
	settings: memorySettings,
	// The first prompt's recall comes on a wake; recall on each prompt and the
	// shadow log need the shim on every prompt that has words to search.
	wakeOnly: {
		'prompt.submit': (context) => {
			const settings = settingsOf(context);
			return !settings['recall-on-prompt'] && !settings['shadow-log'];
		},
	},
	filters: { 'prompt.submit': SEARCHABLE_PROMPT },
	handlers: { 'session.start': sessionStart, 'prompt.submit': promptSubmit, 'task.close': taskClose },
} satisfies ModuleDefinition & { settings: typeof memorySettings };
