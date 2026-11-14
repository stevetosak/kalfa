// The herdr Module's commands. `kalfa herdr continue` starts the successor of
// this session on an open Task (see successor.ts); the `successor` skill asks
// the Operator before it runs it, and exit 3 means a usage limit is near and
// nothing started. `kalfa board` shows every agent session across the Herdr
// workspaces and closes the finished ones (see board.ts). `kalfa space open`
// opens a repository's Workspace from a Preset, and with `--task` a worktree
// for that Task (see space.ts); `kalfa space new` asks for the same values in
// a form (see space-form.ts).
import type { Adapter } from '../../src/adapters/adapter.ts';
import { type Command, parseCommandArgs, UsageError } from '../../src/cli/command.ts';
import type { Io } from '../../src/cli/io.ts';
import { openRecord, taskId } from '../../src/cli/commands/task.ts';
import { requireModule, requireProject } from '../../src/cli/project.ts';
import { KalfaError } from '../../src/core/errors.ts';
import { loadProject } from '../../src/core/project.ts';
import { loadSettings } from '../../src/core/settings.ts';
import { checkLimits, type LimitVerdict, limitsPath } from '../../src/core/usage-limits.ts';
import { cleanWorkspaces, diskLookups, finishedWorkspaces, readSnapshot, renderBoard, type Snapshot } from './board.ts';
import { errorText, type HerdrExec, herdrCli } from './launcher.ts';
import { inquirerPrompter, type Prompter } from './prompter.ts';
import { type FirstPrompt, type GitRun, gitRun, type ModelChoice, openSpace, resolveRepo, type SpaceContext, type SpaceRequest, spaceSettings } from './space.ts';
import { openPopup, PLUGIN_PANES } from './plugin.ts';
import { askSpace, FORM_STARTS, type FormStart, spaceOpenCommand } from './space-form.ts';
import { continueTask, defaultLauncher, type Launcher } from './successor.ts';

export const LIMIT_EXIT = 3;

export interface HerdrCommandDeps {
	launcher?: (adapter: Adapter, env: NodeJS.ProcessEnv) => Launcher;
	limits?: (env: NodeJS.ProcessEnv) => LimitVerdict;
}

/** The harness named by --harness, else the one this command runs in. */
function harness(adapters: ReadonlyMap<string, Adapter>, env: NodeJS.ProcessEnv, flag: string | undefined): Adapter {
	if (flag) {
		const named = adapters.get(flag);
		if (!named) throw new KalfaError(`no Adapter for harness '${flag}' (known: ${[...adapters.keys()].join(', ')})`);
		return named;
	}
	const found = [...adapters.values()].find((a) => a.detect(env));
	if (!found) throw new KalfaError('kalfa cannot tell which harness to start; name it with --harness <name>');
	return found;
}

export function herdrCommand(adapters: ReadonlyMap<string, Adapter>, deps: HerdrCommandDeps = {}): Command {
	return {
		summary: 'herdr Module: start the next session on an open Task (a new Herdr tab, else in the background)',
		usage: 'kalfa herdr continue [--task <id>] [--harness <name>] [--name <session name>] [--model <model>] [--force]\n       (exit 3: a usage limit is near and nothing started; --force starts anyway)',
		async run(args, io) {
			const [sub, ...rest] = args;
			if (sub !== 'continue') throw new UsageError(sub ? `unknown subcommand '${sub}'` : 'give a subcommand');
			const { values } = parseCommandArgs(rest, {
				task: { type: 'string' },
				harness: { type: 'string' },
				name: { type: 'string' },
				model: { type: 'string' },
				force: { type: 'boolean' },
			});
			const project = requireProject(io);
			requireModule(project, 'herdr', io.env);
			const record = openRecord(project, taskId(project, values.task));
			const adapter = harness(adapters, io.env, values.harness);
			const result = continueTask({
				task: record.id,
				cwd: project.root,
				name: values.name,
				model: values.model,
				force: values.force,
				launcher: (deps.launcher ?? defaultLauncher)(adapter, io.env),
				limits: () => (deps.limits ?? ((env) => checkLimits(limitsPath(env))))(io.env),
			});
			if (!result.launched) {
				io.err(`kalfa herdr: ${result.reason}. Nothing started; the Task waits in its record.`);
				return LIMIT_EXIT;
			}
			io.out(result.output);
			io.out(`Usage: ${result.note}.`);
			return 0;
		},
	};
}

export interface BoardCommandDeps {
	exec?: HerdrExec;
	now?: () => number;
}

/** `kalfa board`: every agent session across the Herdr workspaces; `--clean` lists the finished workspaces, `--clean --yes` closes them. */
export function boardCommand(adapters: ReadonlyMap<string, Adapter>, deps: BoardCommandDeps = {}): Command {
	return {
		summary: 'herdr Module: every agent session across the Herdr workspaces, with its Task, state, context, idle time, cache and Next; --clean closes finished workspaces',
		usage: 'kalfa board [--clean [--yes]]   (--clean lists the workspaces whose Tasks are all closed; --yes closes them, after the Operator\'s yes)',
		async run(args, io) {
			const { values } = parseCommandArgs(args, { clean: { type: 'boolean' }, yes: { type: 'boolean' } });
			if (values.yes && !values.clean) throw new UsageError('--yes goes with --clean');
			const exec = deps.exec ?? herdrCli;
			let snapshot: Snapshot;
			try {
				snapshot = readSnapshot(exec);
			} catch (error) {
				throw new KalfaError(`kalfa board reads its sessions from Herdr, and herdr failed: ${errorText(error)}`);
			}
			const lookups = diskLookups(adapters, io.env, (deps.now ?? Date.now)());
			const finished = finishedWorkspaces(snapshot, lookups);
			io.out(values.clean ? cleanWorkspaces(exec, snapshot, finished, values.yes === true).join('\n') : renderBoard(snapshot, lookups, finished));
			return 0;
		},
	};
}

export interface SpaceCommandDeps {
	exec?: HerdrExec;
	git?: GitRun;
	/** The form's questions; the terminal's when absent. */
	prompter?: Prompter;
}

/** The answer @inquirer/prompts gives when the Operator presses Ctrl+C. */
const cancelled = (error: unknown) => error instanceof Error && error.name === 'ExitPromptError';

/** The exit code of a form the Operator cancelled (as for SIGINT), so a popup closes at once. */
export const CANCEL_EXIT = 130;

/** `--model <model>` (every agent tab) and `--model <tab>=<model>` (one tab, by its label or Adapter). */
export function parseModels(values: readonly string[] | undefined): ModelChoice | undefined {
	if (!values?.length) return undefined;
	const choice: { all?: string; tabs: Record<string, string> } = { tabs: {} };
	for (const value of values) {
		const at = value.indexOf('=');
		if (at < 0) {
			if (choice.all) throw new UsageError(`two models for every agent tab: ${choice.all} and ${value}`);
			choice.all = value;
			continue;
		}
		const [tab, model] = [value.slice(0, at).trim(), value.slice(at + 1).trim()];
		if (!tab || !model) throw new UsageError(`--model ${value}: give <tab>=<model> or <model>`);
		choice.tabs[tab] = model;
	}
	return choice;
}

/** `--prompt "<text>"` or `--no-prompt`; neither keeps the default. */
function parseFirstPrompt(text: string | undefined, none: boolean | undefined): FirstPrompt {
	if (none && text !== undefined) throw new UsageError('--prompt and --no-prompt exclude each other');
	if (none) return 'none';
	if (text === undefined) return 'default';
	if (!text.trim()) throw new UsageError('--prompt needs text; --no-prompt starts the agent with no prompt');
	return { text };
}

/** The harness this command runs in, if any. */
export const currentHarness = (adapters: ReadonlyMap<string, Adapter>, env: NodeJS.ProcessEnv) => [...adapters.values()].find((a) => a.detect(env))?.name;

/** `kalfa space open <repo>`: the repository's Workspace from a Preset; with `--task`, a worktree, a branch and a Task Record. `kalfa space new`: the same, from a form. */
export function spaceCommand(adapters: ReadonlyMap<string, Adapter>, deps: SpaceCommandDeps = {}): Command {
	return {
		summary: "herdr Module: open a repository's Workspace in Herdr from a Preset; --task opens a worktree for a Task; new asks in a form",
		usage: [
			'kalfa space new [--mode new|open] [--hold-on-error]',
			'  a form: asks each value below with a default, shows the matching space open command, and opens it after a yes.',
			'  --mode new: a new Task (no mode question); --mode open: an open Task or the Workspace. --hold-on-error: an error waits for Enter (a popup).',
			`kalfa space popup <${PLUGIN_PANES.join('|')}>   (the Herdr plugin's action: opens that popup pane in the Workspace's folder)`,
			'kalfa space open <repo> [--preset <name>] [--model [<tab>=]<model>]… [--prompt "<text>" | --no-prompt]',
			'kalfa space open <repo> --task <branch> ["<goal>" --done-when "<finish line>" [--plan <path>] [--base <ref>]] [--preset <name>] [--model …] [--prompt … | --no-prompt]',
			'  <repo>: a path, or a bare name looked up in settings.herdr.space-dirs. An open Workspace is only focused, unless --preset is given.',
			'  --task: a worktree in <repo>.worktrees/<task> next to the repository; a new Task needs its goal and --done-when.',
			"  --base: the start of a new branch (default: origin's default branch).",
			'  --model: <model> for every agent tab, <tab>=<model> for the tab with that label (or Adapter name, when it has no label).',
			'  --prompt / --no-prompt: the first agent tab starts on this text / on no prompt (default: the successor prompt for a Task, else none).',
		].join('\n'),
		async run(args, io) {
			const [sub, ...rest] = args;
			if (sub !== 'open' && sub !== 'new' && sub !== 'popup') throw new UsageError(sub ? `unknown subcommand '${sub}'` : 'give a subcommand');
			if (sub === 'popup') {
				const [pane, ...extra] = rest;
				if (!pane || extra.length) throw new UsageError(`kalfa space popup takes one pane: ${PLUGIN_PANES.join(' or ')}`);
				io.out(openPopup(deps.exec ?? herdrCli, io.env, io.cwd, pane));
				return 0;
			}
			const settings = spaceSettings(loadSettings(io.env), loadProject(io.cwd));
			const context: SpaceContext = { settings, adapters, harness: currentHarness(adapters, io.env), exec: deps.exec ?? herdrCli, git: deps.git ?? gitRun };
			if (sub === 'new') return spaceForm(rest, io, context, deps.prompter);

			const { values, positionals } = parseCommandArgs(
				rest,
				{
					preset: { type: 'string' },
					task: { type: 'string' },
					'done-when': { type: 'string' },
					plan: { type: 'string' },
					base: { type: 'string' },
					model: { type: 'string', multiple: true },
					prompt: { type: 'string' },
					'no-prompt': { type: 'boolean' },
				},
				true,
			);
			const [repo, ...goalWords] = positionals;
			if (!repo) throw new UsageError('name the repository: a path (. for this one) or a bare name from space-dirs');
			const goal = goalWords.join(' ').trim();
			const doneWhen = values['done-when']?.replace(/\s+/g, ' ').trim();
			if (!values.task && (goal || doneWhen || values.plan || values.base)) throw new UsageError('a goal, --done-when, --plan and --base go with --task');

			const request: SpaceRequest = {
				main: resolveRepo(repo, io.cwd, settings['space-dirs'], io.env),
				preset: values.preset,
				task: values.task ? { branch: values.task, goal: goal || undefined, doneWhen: doneWhen || undefined, plan: values.plan, base: values.base } : undefined,
				models: parseModels(values.model),
				firstPrompt: parseFirstPrompt(values.prompt, values['no-prompt']),
			};
			io.out(openSpace(request, context).join('\n'));
			return 0;
		},
	};
}

/** `kalfa space new`: the form's answers, the matching command, and the space after a yes. */
async function spaceForm(args: string[], io: Io, context: SpaceContext, given: Prompter | undefined): Promise<number> {
	const { values } = parseCommandArgs(args, { mode: { type: 'string' }, 'hold-on-error': { type: 'boolean' } });
	const start = values.mode;
	if (start !== undefined && !(FORM_STARTS as readonly string[]).includes(start)) throw new UsageError(`--mode ${start}: give ${FORM_STARTS.join(' or ')}`);
	if (!given && !(process.stdin.isTTY && process.stdout.isTTY)) throw new KalfaError('kalfa space new asks questions and needs a terminal; use kalfa space open with flags');
	const prompter = given ?? inquirerPrompter;
	try {
		const request = await askSpace(prompter, { settings: context.settings, harness: context.harness, git: context.git, cwd: io.cwd, env: io.env }, start as FormStart | undefined);
		const command = spaceOpenCommand(request, io.env);
		io.out(`The same with flags:\n  ${command}`);
		if (!(await prompter.confirm('Open this space?', { default: true }))) {
			io.out('Nothing opened.');
			return 0;
		}
		io.out(openSpace(request, context).join('\n'));
		return 0;
	} catch (error) {
		if (cancelled(error)) {
			io.err('Cancelled; nothing opened.');
			return CANCEL_EXIT;
		}
		if (!values['hold-on-error']) throw error;
		// A popup closes when its command exits: any error stays until the Operator has read it.
		io.err(`kalfa space: ${error instanceof Error ? error.message : String(error)}`);
		await prompter.input('Press Enter to close').catch(() => '');
		return 1;
	}
}
