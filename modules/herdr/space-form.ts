// `kalfa space new`: the guided form over `kalfa space open`. The form has no
// logic of its own: it asks the Operator for each value, offers a default for
// every value that can have one, and builds the same `SpaceRequest` the
// `space open` flags build. `spaceOpenCommand` renders that request as the
// matching command line, so the Operator sees what runs and can type it next
// time. The form depends on `Prompter` only, so tests give set answers.
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { KalfaError } from '../../src/core/errors.ts';
import { findPlans } from '../../src/core/plans.ts';
import { loadProject } from '../../src/core/project.ts';
import { listRecords } from '../../src/core/task-record.ts';
import type { Choice, Prompter } from './prompter.ts';
import { expandHome, type FirstPrompt, type GitRun, type ModelChoice, type PresetTab, presetTabs, remoteDefault, resolveRepo, type SpaceRequest, type SpaceSettings, tabKey } from './space.ts';

export interface FormContext {
	settings: SpaceSettings;
	/** The harness this command runs in: the agent tab when there is no Preset at all. */
	harness: string | undefined;
	git: GitRun;
	cwd: string;
	env: NodeJS.ProcessEnv;
}

type Mode = 'new' | 'open' | 'workspace';

/** What the form opens: a new Task (no mode question), an open Task or the Workspace, or any of the three (default: a new Task). */
export const FORM_STARTS = ['new', 'open'] as const;
export type FormStart = (typeof FORM_STARTS)[number];

/** The folder of the Herdr Workspace the form was opened from (the plugin context), else the current folder. */
export function startFolder(env: NodeJS.ProcessEnv, cwd: string): string {
	try {
		const context = JSON.parse(env.HERDR_PLUGIN_CONTEXT_JSON ?? '') as { workspace_cwd?: unknown };
		if (typeof context.workspace_cwd === 'string' && context.workspace_cwd) return context.workspace_cwd;
	} catch {
		// No plugin context, or not JSON: the current folder.
	}
	return cwd;
}

/** The repository of `folder`, if it is in one. */
function repoOf(folder: string, ctx: FormContext): string | undefined {
	try {
		return resolveRepo(folder.startsWith('/') ? folder : `./${folder}`, ctx.cwd, [], ctx.env);
	} catch {
		return undefined;
	}
}

const shortHome = (path: string, env: NodeJS.ProcessEnv) => {
	const home = env.HOME || homedir();
	return path.startsWith(`${home}/`) ? `~/${path.slice(home.length + 1)}` : path;
};

/** Every repository in the space-dirs, the start folder's one first: the search preselects it. */
export function repoChoices(ctx: FormContext): Choice<string>[] {
	const found = new Map<string, Choice<string>>();
	const here = repoOf(startFolder(ctx.env, ctx.cwd), ctx);
	const add = (main: string) => {
		if (!found.has(main)) found.set(main, { value: main, name: main.split('/').at(-1)!, description: shortHome(main, ctx.env) });
	};
	if (here) add(here);
	for (const dir of ctx.settings['space-dirs']) {
		const folder = expandHome(dir, ctx.env);
		if (!existsSync(folder)) continue;
		for (const entry of readdirSync(folder, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
			if (!entry.isDirectory() || !existsSync(join(folder, entry.name, '.git'))) continue;
			const main = repoOf(join(folder, entry.name), ctx);
			if (main) add(main);
		}
	}
	if (!found.size) throw new KalfaError('no repository to offer: this folder is in none and settings.herdr.space-dirs names none; run kalfa space new inside a repository, or add space-dirs to the machine settings');
	return [...found.values()];
}

const NO_PLAN = '';

/** The open Plans of the repository; the default is the only active one, else none. */
function planChoices(main: string): { choices: Choice<string>[]; fallback: string } {
	const globs = loadProject(main)?.file?.plans ?? [];
	const open = globs.length ? findPlans(main, globs).plans.filter((plan) => plan.status === 'active' || plan.status === 'proposed') : [];
	const active = open.filter((plan) => plan.status === 'active');
	return {
		choices: [{ value: NO_PLAN, name: 'No Plan' }, ...open.map((plan) => ({ value: plan.path, name: plan.title, description: `${plan.status}; ${plan.path}` }))],
		fallback: active.length === 1 ? active[0]!.path : NO_PLAN,
	};
}

const hasOrigin = (git: GitRun, main: string) => git(main, ['remote']).split('\n').includes('origin');

/** Origin's branches after a fetch, its default branch first; none without an origin (a new branch then starts at HEAD). */
export function baseChoices(git: GitRun, main: string): { choices: Choice<string>[]; fallback: string } | undefined {
	if (!hasOrigin(git, main)) return undefined;
	try {
		git(main, ['fetch', '--quiet', 'origin']);
	} catch {
		// Offline: the branches origin had at the last fetch.
	}
	const fallback = remoteDefault(git, main);
	const refs = git(main, ['for-each-ref', '--format=%(refname:short)', 'refs/remotes/origin'])
		.split('\n')
		.filter((ref) => ref.startsWith('origin/') && ref !== 'origin/HEAD' && ref !== fallback);
	return { choices: [fallback, ...refs].map((ref) => ({ value: ref, name: ref })), fallback };
}

const required = (what: string) => (value: string) => (value.trim() ? true : `give the ${what}`);

/** A branch name git accepts. */
const branchName = (git: GitRun, main: string) => (value: string) => {
	if (!value.trim()) return 'give the branch';
	try {
		git(main, ['check-ref-format', '--branch', value.trim()]);
		return true;
	} catch {
		return `'${value.trim()}' is not a valid branch name`;
	}
};

/** The agent tabs' models: one question per tab key; only a changed model goes into the request. */
async function askModels(prompter: Prompter, tabs: readonly PresetTab[]): Promise<ModelChoice | undefined> {
	const chosen: Record<string, string> = {};
	const asked = new Set<string>();
	for (const tab of tabs) {
		if (!('agent' in tab) || asked.has(tabKey(tab))) continue;
		const key = tabKey(tab);
		asked.add(key);
		const keep = tab.model ?? '';
		const model = (await prompter.input(`Model of agent tab "${key}" (empty: the harness's default)`, { default: keep })).trim();
		if (model && model !== keep) chosen[key] = model;
	}
	return Object.keys(chosen).length ? { tabs: chosen } : undefined;
}

/** The first agent tab's start; the default (the successor prompt for a Task, else none) is listed first. */
async function askFirstPrompt(prompter: Prompter, task: boolean): Promise<FirstPrompt> {
	type Start = 'default' | 'none' | 'text';
	const choices: Choice<Start>[] = task
		? [
				{ value: 'default', name: 'Continue the Task', description: 'the successor prompt: the agent reads the Task Record and goes on' },
				{ value: 'text', name: 'My own text' },
				{ value: 'none', name: 'No prompt', description: 'the agent waits for you' },
			]
		: [
				{ value: 'default', name: 'No prompt', description: 'the agent waits for you' },
				{ value: 'text', name: 'My own text' },
			];
	const start = await prompter.select<Start>('First prompt of the first agent tab', choices, { default: 'default' });
	if (start !== 'text') return start;
	return { text: (await prompter.input('First prompt', { validate: required('prompt text') })).trim() };
}

/** The mode: asked only when more than one applies. */
async function askMode(prompter: Prompter, start: FormStart | undefined, hasOpenTask: boolean): Promise<Mode> {
	if (start === 'new') return 'new';
	const modes: Choice<Mode>[] = [
		...(start === undefined ? [{ value: 'new' as const, name: 'New Task', description: 'a worktree on a new branch, a Task Record and the Preset tabs' }] : []),
		...(hasOpenTask ? [{ value: 'open' as const, name: 'Open Task', description: 'the worktree of an open Task and the Preset tabs' }] : []),
		{ value: 'workspace', name: 'Workspace only', description: 'the Preset tabs in the main checkout' },
	];
	if (modes.length === 1) return modes[0]!.value;
	return prompter.select('What to open', modes, { default: modes[0]!.value });
}

/** Asks the Operator for each value of a space, with its default, and builds the request. */
export async function askSpace(prompter: Prompter, ctx: FormContext, start?: FormStart): Promise<SpaceRequest> {
	const presetNames = Object.keys(ctx.settings.presets);
	if (!presetNames.length && !ctx.harness) throw new KalfaError('no Preset to open: add one under settings.herdr.presets in the machine settings (~/.config/kalfa/config.yaml)');

	const main = await prompter.search('Repository', repoChoices(ctx));
	/** An open Task without a branch has no worktree to open. */
	const openTasks = listRecords(main).flatMap((record) => (record.header.status === 'open' && record.header.branch ? [{ id: record.id, goal: record.header.goal, branch: record.header.branch }] : []));
	const mode = await askMode(prompter, start, openTasks.length > 0);

	const request: SpaceRequest = { main };
	if (mode === 'new') {
		const branch = (await prompter.input('Branch', { validate: branchName(ctx.git, main) })).trim();
		const goal = (await prompter.input('Goal', { validate: required('goal') })).trim();
		const doneWhen = (await prompter.input('Done when', { validate: required('finish line') })).replace(/\s+/g, ' ').trim();
		const plans = planChoices(main);
		const plan = plans.choices.length > 1 ? await prompter.select('Plan', plans.choices, { default: plans.fallback }) : NO_PLAN;
		const bases = baseChoices(ctx.git, main);
		const base = bases ? await prompter.search(`Base branch (default: ${bases.fallback})`, bases.choices) : undefined;
		request.task = { branch, goal, doneWhen, plan: plan || undefined, base: base === bases?.fallback ? undefined : base };
	} else if (mode === 'open') {
		const choices = openTasks.map((task) => ({ value: task.branch, name: task.id, description: task.goal }));
		request.task = { branch: await prompter.search('Task', choices) };
	}

	if (presetNames.length) {
		const fallback = ctx.settings['default-preset'] ?? presetNames[0]!;
		const choices = presetNames.map((name) => ({ value: name, name, description: ctx.settings.presets[name]!.map((tab) => tab.label ?? ('agent' in tab ? tab.agent : tab.run)).join(', ') }));
		request.preset = await prompter.select('Preset', choices, { default: fallback });
	}
	const tabs = presetTabs(ctx.settings, request.preset, ctx.harness);
	request.models = await askModels(prompter, tabs);
	if (tabs.some((tab) => 'agent' in tab)) request.firstPrompt = await askFirstPrompt(prompter, request.task !== undefined);
	return request;
}

/** A shell word: quoted only when it holds more than plain path characters. */
const word = (text: string) => (/^[\w@%+=:,./~-]+$/.test(text) ? text : `'${text.replaceAll("'", `'\\''`)}'`);

/** The `kalfa space open` command that makes the same request. */
export function spaceOpenCommand(request: SpaceRequest, env: NodeJS.ProcessEnv): string {
	const parts = ['kalfa', 'space', 'open', shortHome(request.main, env)];
	const { task, models, firstPrompt } = request;
	if (task) {
		parts.push('--task', task.branch);
		if (task.goal) parts.push(task.goal);
		if (task.doneWhen) parts.push('--done-when', task.doneWhen);
		if (task.plan) parts.push('--plan', task.plan);
		if (task.base) parts.push('--base', task.base);
	}
	if (request.preset) parts.push('--preset', request.preset);
	if (models?.all) parts.push('--model', models.all);
	for (const [tab, model] of Object.entries(models?.tabs ?? {})) parts.push('--model', `${tab}=${model}`);
	if (firstPrompt === 'none') parts.push('--no-prompt');
	else if (firstPrompt && firstPrompt !== 'default') parts.push('--prompt', firstPrompt.text);
	return parts.map(word).join(' ');
}
