// `kalfa space open`: a repository's Workspace in Herdr, set up from a Preset.
// The Workspace is the one labelled with the main checkout's folder name, as
// the successor and the board find it. A Preset is the Operator's own: an
// ordered list of tabs in the machine settings (`settings.herdr.presets`),
// never in `kalfa.yaml`. An existing Workspace is only focused, unless a
// Preset is named, so running it again adds nothing. With `--task` the work
// gets its own git worktree next to the repository, on its own branch, with
// its Task Record (kept in the main checkout), and the Preset's tabs open
// there, the agent on the successor prompt.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import type { Adapter, SessionLaunch } from '../../src/adapters/adapter.ts';
import { UsageError } from '../../src/cli/command.ts';
import { startTask } from '../../src/cli/commands/task.ts';
import { currentBranch } from '../../src/core/git.ts';
import { mainCheckout } from '../../src/core/private-dir.ts';
import { KalfaError } from '../../src/core/errors.ts';
import type { Project } from '../../src/core/project.ts';
import { loadProject, repoRootOf } from '../../src/core/project.ts';
import type { Settings } from '../../src/core/settings.ts';
import { readRecord, taskIdOf } from '../../src/core/task-record.ts';
import { errorText, findWorkspace, focus, type HerdrExec, liveNames, newTab, type Opened, startAgent, workspaceLabel } from './launcher.ts';
import { successorPrompt } from './successor.ts';

const label = z.string().min(1);

const tabSchema = z.union([
	/** An agent tab: the harness of that Adapter, started as a Herdr agent so the board sees it. */
	z.strictObject({ agent: z.string().min(1), label: label.optional(), model: z.string().min(1).optional() }),
	/** A command tab: the command runs in the tab's pane. */
	z.strictObject({ run: z.string().min(1), label }),
]);

export type PresetTab = z.infer<typeof tabSchema>;

const homeDir = z.string().refine((dir) => dir.startsWith('/') || dir.startsWith('~/'), 'a folder is an absolute path or starts with ~/');

/** The herdr Module's machine settings. */
export const spaceSettingsSchema = z
	.strictObject({
		presets: z.record(z.string().regex(/^[a-z][a-z0-9_-]*$/, 'a Preset name is lower-case letters, digits, - and _'), z.array(tabSchema).min(1)).default({}),
		'default-preset': z.string().optional(),
		/** Folders where a bare repository name is looked up, in order. */
		'space-dirs': z.array(homeDir).default([]),
	})
	.refine((s) => !s['default-preset'] || s['default-preset'] in s.presets, { message: 'default-preset names no Preset in presets', path: ['default-preset'] });

export type SpaceSettings = z.infer<typeof spaceSettingsSchema>;

/** The machine's part only: Presets are personal, so `settings.herdr` in `kalfa.yaml` is refused. */
export function spaceSettings(machine: Settings, project: Project | undefined): SpaceSettings {
	const inProject = project?.file?.settings.herdr;
	if (inProject && typeof inProject === 'object' && Object.keys(inProject).length) {
		throw new KalfaError('settings.herdr in kalfa.yaml: Presets are personal; move them to the machine settings (~/.config/kalfa/config.yaml)');
	}
	const result = spaceSettingsSchema.safeParse(machine.settings?.herdr ?? {});
	if (!result.success) throw new KalfaError(`settings.herdr (the machine settings): ${result.error.issues.map((i) => `${i.path.join('.') || '(top)'}: ${i.message}`).join('; ')}`);
	return result.data;
}

const expandHome = (dir: string, env: NodeJS.ProcessEnv) => (dir.startsWith('~/') ? join(env.HOME || homedir(), dir.slice(2)) : dir);

/** The main checkout of `<repo>`: a path (it has a `/`, or starts with `.` or `~`), or a bare name looked up in `space-dirs`. */
export function resolveRepo(repo: string, cwd: string, dirs: readonly string[], env: NodeJS.ProcessEnv): string {
	if (repo.includes('/') || repo.startsWith('.') || repo.startsWith('~')) {
		const path = repo === '~' ? expandHome('~/', env) : resolve(cwd, expandHome(repo, env));
		const root = repoRootOf(path);
		if (!root) throw new KalfaError(`${path} is not in a git repository`);
		return mainCheckout(root);
	}
	for (const dir of dirs) {
		const candidate = join(expandHome(dir, env), repo);
		if (existsSync(join(candidate, '.git'))) return mainCheckout(candidate);
	}
	throw new KalfaError(dirs.length ? `no repository '${repo}' in ${dirs.join(', ')} (space-dirs)` : `'${repo}' is a bare name and the machine settings have no settings.herdr.space-dirs; give a path`);
}

/** The Preset's tabs: the named one, else the default one, else one agent tab of `harness`. */
export function presetTabs(settings: SpaceSettings, name: string | undefined, harness: string | undefined): PresetTab[] {
	const chosen = name ?? settings['default-preset'];
	if (chosen) {
		const tabs = settings.presets[chosen];
		if (!tabs) throw new KalfaError(`no Preset '${chosen}' (known: ${Object.keys(settings.presets).join(', ') || 'none'}); add it under settings.herdr.presets in the machine settings`);
		return tabs;
	}
	if (!harness) throw new KalfaError('no Preset given and no default-preset; name one with --preset, or run inside a harness');
	return [{ agent: harness }];
}

export type GitRun = (cwd: string, args: string[]) => string;

export const gitRun: GitRun = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

const succeeds = (git: GitRun, cwd: string, args: string[]) => {
	try {
		git(cwd, args);
		return true;
	} catch {
		return false;
	}
};

/** The remote's default branch, e.g. `origin/main`. */
function remoteDefault(git: GitRun, main: string): string {
	try {
		return git(main, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
	} catch {
		const known = ['origin/main', 'origin/master'].find((ref) => succeeds(git, main, ['rev-parse', '--verify', '--quiet', ref]));
		if (!known) throw new KalfaError('origin has no default branch kalfa can find; run: git remote set-head origin --auto');
		return known;
	}
}

export interface Worktree {
	path: string;
	/** What was done, for the Operator. */
	note: string;
}

/** Where the worktree of a Task goes: next to the repository, in `<repo>.worktrees/<task>`. */
export const worktreePath = (main: string, task: string) => join(dirname(main), `${basename(main)}.worktrees`, task);

/** The commit `base` names: a ref as given, else the branch of that name on origin. */
function baseRef(git: GitRun, main: string, base: string): string {
	const ref = [base, `origin/${base}`].find((candidate) => succeeds(git, main, ['rev-parse', '--verify', '--quiet', `${candidate}^{commit}`]));
	if (!ref) throw new KalfaError(`--base ${base}: no branch, tag or commit of that name here or on origin`);
	return ref;
}

/**
 * The Task's worktree on `branch`: an existing one is used; else the branch is
 * checked out there when it exists (here or on origin), or made after a fetch
 * from `base` when given, else from origin's default branch (from HEAD when
 * there is no origin). `base` counts only for a new branch.
 */
export function prepareWorktree(main: string, branch: string, git: GitRun = gitRun, base?: string): Worktree {
	const path = worktreePath(main, taskIdOf(branch));
	const unused = base ? `; --base ${base} is not used, the branch exists` : '';
	if (existsSync(path)) {
		const root = repoRootOf(path);
		if (root !== path || mainCheckout(path) !== main) throw new KalfaError(`${path} exists and is not a worktree of ${main}; move it away`);
		const on = currentBranch(path);
		if (on !== branch) throw new KalfaError(`the worktree ${path} is on ${on ?? 'no branch'}, not ${branch}`);
		return { path, note: `Worktree ${path} (${branch}) exists: using it${unused}` };
	}
	const origin = git(main, ['remote']).split('\n').includes('origin');
	if (origin) git(main, ['fetch', '--quiet', 'origin']);
	if (succeeds(git, main, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`])) {
		git(main, ['worktree', 'add', '--quiet', path, branch]);
		return { path, note: `Worktree ${path} on the existing branch ${branch}${unused}` };
	}
	if (origin && succeeds(git, main, ['show-ref', '--verify', '--quiet', `refs/remotes/origin/${branch}`])) {
		git(main, ['worktree', 'add', '--quiet', '--track', '-b', branch, path, `origin/${branch}`]);
		return { path, note: `Worktree ${path} on ${branch}, tracking origin/${branch}${unused}` };
	}
	const from = base ? baseRef(git, main, base) : origin ? remoteDefault(git, main) : 'HEAD';
	git(main, ['worktree', 'add', '--quiet', '--no-track', '-b', branch, path, from]);
	const what = base || origin ? from : `HEAD (${currentBranch(main) ?? 'detached'}; no origin)`;
	return { path, note: `Worktree ${path} on the new branch ${branch} from ${what}` };
}

/** One tab to open: its title, folder and, for an agent tab, the prompt it starts on. */
export interface TabPlan {
	title: string;
	cwd: string;
	tab: PresetTab;
	prompt?: string;
}

/** The Adapter's session of each agent tab, checked before Herdr changes anything. */
export function sessionsOf(tabs: readonly PresetTab[], adapters: ReadonlyMap<string, Adapter>): Map<string, SessionLaunch> {
	const sessions = new Map<string, SessionLaunch>();
	for (const tab of tabs) {
		if (!('agent' in tab)) continue;
		const session = adapters.get(tab.agent)?.session;
		if (!session) throw new KalfaError(`Preset tab agent '${tab.agent}': kalfa cannot start it (Adapters with sessions: ${[...adapters.values()].filter((a) => a.session).map((a) => a.name).join(', ')})`);
		sessions.set(tab.agent, session);
	}
	return sessions;
}

/** Opens the tabs in the workspace (a new one labelled `label` when there is none), focuses the first one, and says what happened. */
export function openTabs(exec: HerdrExec, sessions: ReadonlyMap<string, SessionLaunch>, label: string, workspace: string | undefined, plans: readonly TabPlan[]): string[] {
	const lines: string[] = [];
	const taken = liveNames(exec);
	let first: Opened | undefined;
	for (const plan of plans) {
		const opened = newTab(exec, workspace, label, plan.cwd, plan.title);
		workspace = opened.workspace;
		first ??= opened;
		const where = `tab "${plan.title}" (${opened.tab}) in workspace ${label} (${opened.workspace})`;
		const { tab } = plan;
		if ('agent' in tab) {
			lines.push(startAgent(exec, opened, tab.agent, sessions.get(tab.agent)!, { name: plan.title, prompt: plan.prompt, model: tab.model }, where, taken));
		} else {
			exec(['pane', 'run', opened.pane, tab.run]);
			lines.push(`Ran ${tab.run} in ${where}`);
		}
	}
	if (first) lines.push(`Focus: ${focus(exec, first)}.`);
	return lines;
}

/** The title of a tab: its label, else `fallback`; a Task's tabs start with the Task id. */
export function tabTitle(tab: PresetTab, fallback: string, task?: string): string {
	if (!task) return tab.label ?? fallback;
	return tab.label ? `${task} ${tab.label}` : task;
}

/** The Workspace of an existing workspace id: focused, and nothing added. */
export function focusOnly(exec: HerdrExec, label: string, workspace: string): string {
	return `Workspace ${label} (${workspace}) is open: ${focus(exec, { workspace })}; no tabs added (--preset <name> adds a Preset's tabs).`;
}

/** The first agent tab's start: the default (the successor prompt for a Task, else none), no prompt, or the Operator's text. */
export type FirstPrompt = 'default' | 'none' | { text: string };

/** Models for this run: `all` for every agent tab, `tabs` by tab key (see tabKey), which wins. */
export interface ModelChoice {
	all?: string;
	tabs?: Readonly<Record<string, string>>;
}

export interface TaskRequest {
	/** The branch; the Task id comes from it. */
	branch: string;
	/** A new Task needs its goal and Done when; an open Task needs neither. */
	goal?: string;
	doneWhen?: string;
	plan?: string;
	/** The base of a new branch; origin's default branch when absent. */
	base?: string;
}

/** What `kalfa space open` and the `kalfa space new` form both ask for. */
export interface SpaceRequest {
	/** The repository's main checkout (see resolveRepo). */
	main: string;
	/** A named Preset; an open Workspace gets tabs only when one is named (or with a Task). */
	preset?: string;
	task?: TaskRequest;
	models?: ModelChoice;
	firstPrompt?: FirstPrompt;
}

export interface SpaceContext {
	settings: SpaceSettings;
	adapters: ReadonlyMap<string, Adapter>;
	/** The harness this command runs in: the agent tab when there is no Preset at all. */
	harness: string | undefined;
	exec: HerdrExec;
	git: GitRun;
}

/** The name a `--model <tab>=<model>` choice uses for an agent tab: its label, else its Adapter. */
export const tabKey = (tab: Extract<PresetTab, { agent: string }>) => tab.label ?? tab.agent;

/** The Preset's tabs with this run's models; a model for no agent tab is refused, so a typo never passes silently. */
export function withModels(tabs: readonly PresetTab[], models: ModelChoice | undefined): PresetTab[] {
	const named = models?.tabs ?? {};
	const keys = new Set(tabs.flatMap((tab) => ('agent' in tab ? [tabKey(tab)] : [])));
	const unknown = Object.keys(named).filter((key) => !keys.has(key));
	if (unknown.length) throw new KalfaError(`--model ${unknown.join(', ')}: no agent tab of that name in the Preset (agent tabs: ${[...keys].join(', ') || 'none'})`);
	return tabs.map((tab) => {
		if (!('agent' in tab)) return tab;
		const model = named[tabKey(tab)] ?? models?.all ?? tab.model;
		return model ? { ...tab, model } : tab;
	});
}

/** The first agent tab's prompt, or undefined for none. */
function leadPrompt(first: FirstPrompt, task: string | undefined): string | undefined {
	if (first === 'none') return undefined;
	if (first === 'default') return task ? successorPrompt(task) : undefined;
	return first.text;
}

/**
 * Opens the space a request asks for, and says what happened. Without a Task:
 * an open Workspace is only focused unless a Preset is named, else the
 * Preset's tabs open in the main checkout. With a Task: the worktree, the
 * Task Record when it is new, and the Preset's tabs in the worktree; only the
 * first agent tab gets the first prompt, since two sessions never share one
 * Task Record.
 */
export function openSpace(request: SpaceRequest, ctx: SpaceContext): string[] {
	const { main, task } = request;
	const first = request.firstPrompt ?? 'default';
	const tabs = withModels(presetTabs(ctx.settings, request.preset, ctx.harness), request.models);
	const sessions = sessionsOf(tabs, ctx.adapters);
	const lead = tabs.findIndex((tab) => 'agent' in tab);
	if (first !== 'default' && lead < 0) throw new UsageError('--prompt and --no-prompt need an agent tab in the Preset');
	const label = workspaceLabel(main);
	const workspace = herdrStep(() => findWorkspace(ctx.exec, label));

	if (!task) {
		if (workspace && !request.preset) {
			if (request.models || first !== 'default') throw new UsageError('the Workspace is open and only gets focus: --model, --prompt and --no-prompt go with --preset or --task');
			return [herdrStep(() => focusOnly(ctx.exec, label, workspace))];
		}
		const prompt = leadPrompt(first, undefined);
		const plans = tabs.map((tab, n) => ({ title: tabTitle(tab, label), cwd: main, tab, prompt: n === lead ? prompt : undefined }));
		return herdrStep(() => openTabs(ctx.exec, sessions, label, workspace, plans));
	}

	const id = taskIdOf(task.branch);
	const existing = readRecord(main, id);
	if (existing?.header.status === 'closed') throw new KalfaError(`Task '${id}' is closed`);
	if (!existing && !(task.goal && task.doneWhen)) throw new UsageError(`Task '${id}' is new: give its goal and --done-when "<finish line>"`);
	const lines: string[] = [];
	const worktree = prepareWorktree(main, task.branch, ctx.git, task.base);
	lines.push(worktree.note);
	if (existing) {
		if (task.goal || task.doneWhen || task.plan) lines.push(`Task ${id} exists: its goal and Done when stay as the record has them.`);
	} else {
		const project = loadProject(worktree.path);
		if (!project) throw new KalfaError(`${worktree.path} is not a repository`);
		lines.push(`Task ${id} started: ${startTask(project, id, { goal: task.goal!, doneWhen: task.doneWhen!, plan: task.plan })}`);
	}
	const prompt = leadPrompt(first, id);
	const plans = tabs.map((tab, n) => ({ title: tabTitle(tab, label, id), cwd: worktree.path, tab, prompt: n === lead ? prompt : undefined }));
	return [...lines, ...herdrStep(() => openTabs(ctx.exec, sessions, label, workspace, plans))];
}

/** A Herdr step: its failure names Herdr, so the Operator knows which tool failed. */
function herdrStep<T>(step: () => T): T {
	try {
		return step();
	} catch (error) {
		if (error instanceof KalfaError || error instanceof UsageError) throw error;
		throw new KalfaError(`kalfa space opens Herdr tabs, and herdr failed: ${errorText(error)}`);
	}
}
