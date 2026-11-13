// The herdr Module's commands. `kalfa herdr continue` starts the successor of
// this session on an open Task (see successor.ts); the `successor` skill asks
// the Operator before it runs it, and exit 3 means a usage limit is near and
// nothing started. `kalfa board` shows every agent session across the Herdr
// workspaces and closes the finished ones (see board.ts). `kalfa space open`
// opens a repository's Workspace from a Preset, and with `--task` a worktree
// for that Task (see space.ts).
import type { Adapter } from '../../src/adapters/adapter.ts';
import { type Command, parseCommandArgs, UsageError } from '../../src/cli/command.ts';
import { openRecord, startTask, taskId } from '../../src/cli/commands/task.ts';
import { requireModule, requireProject } from '../../src/cli/project.ts';
import { KalfaError } from '../../src/core/errors.ts';
import { loadProject } from '../../src/core/project.ts';
import { loadSettings } from '../../src/core/settings.ts';
import { readRecord, taskIdOf } from '../../src/core/task-record.ts';
import { checkLimits, type LimitVerdict, limitsPath } from '../../src/core/usage-limits.ts';
import { cleanWorkspaces, diskLookups, finishedWorkspaces, readSnapshot, renderBoard, type Snapshot } from './board.ts';
import { errorText, findWorkspace, type HerdrExec, herdrCli, workspaceLabel } from './launcher.ts';
import { focusOnly, type GitRun, gitRun, openTabs, prepareWorktree, presetTabs, resolveRepo, sessionsOf, spaceSettings, tabTitle } from './space.ts';
import { continueTask, defaultLauncher, type Launcher, successorPrompt } from './successor.ts';

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
}

/** `kalfa space open <repo>`: the repository's Workspace from a Preset; with `--task`, a worktree, a branch and a Task Record. */
export function spaceCommand(adapters: ReadonlyMap<string, Adapter>, deps: SpaceCommandDeps = {}): Command {
	return {
		summary: "herdr Module: open a repository's Workspace in Herdr from a Preset; --task opens a worktree for a Task",
		usage: [
			'kalfa space open <repo> [--preset <name>]',
			'kalfa space open <repo> --task <branch> ["<goal>" --done-when "<finish line>" [--plan <path>]] [--preset <name>]',
			'  <repo>: a path, or a bare name looked up in settings.herdr.space-dirs. An open Workspace is only focused, unless --preset is given.',
			'  --task: a worktree in <repo>.worktrees/<task> next to the repository; a new Task needs its goal and --done-when.',
		].join('\n'),
		async run(args, io) {
			const [sub, ...rest] = args;
			if (sub !== 'open') throw new UsageError(sub ? `unknown subcommand '${sub}'` : 'give a subcommand');
			const { values, positionals } = parseCommandArgs(rest, { preset: { type: 'string' }, task: { type: 'string' }, 'done-when': { type: 'string' }, plan: { type: 'string' } }, true);
			const [repo, ...goalWords] = positionals;
			if (!repo) throw new UsageError('name the repository: a path (. for this one) or a bare name from space-dirs');
			const goal = goalWords.join(' ').trim();
			const doneWhen = values['done-when']?.replace(/\s+/g, ' ').trim();
			if (!values.task && (goal || doneWhen || values.plan)) throw new UsageError('a goal, --done-when and --plan go with --task');

			const settings = spaceSettings(loadSettings(io.env), loadProject(io.cwd));
			const main = resolveRepo(repo, io.cwd, settings['space-dirs'], io.env);
			const harness = [...adapters.values()].find((a) => a.detect(io.env))?.name;
			const tabs = presetTabs(settings, values.preset, harness);
			const sessions = sessionsOf(tabs, adapters);
			const exec = deps.exec ?? herdrCli;
			const label = workspaceLabel(main);
			const herdr = <T>(step: () => T): T => {
				try {
					return step();
				} catch (error) {
					throw new KalfaError(`kalfa space opens Herdr tabs, and herdr failed: ${errorText(error)}`);
				}
			};
			const workspace = herdr(() => findWorkspace(exec, label));

			if (!values.task) {
				if (workspace && !values.preset) {
					io.out(herdr(() => focusOnly(exec, label, workspace)));
					return 0;
				}
				const plans = tabs.map((tab) => ({ title: tabTitle(tab, label), cwd: main, tab }));
				io.out(herdr(() => openTabs(exec, sessions, label, workspace, plans)).join('\n'));
				return 0;
			}

			const id = taskIdOf(values.task);
			const existing = readRecord(main, id);
			if (existing?.header.status === 'closed') throw new KalfaError(`Task '${id}' is closed`);
			if (!existing && !(goal && doneWhen)) throw new UsageError(`Task '${id}' is new: give its goal and --done-when "<finish line>"`);
			const worktree = prepareWorktree(main, values.task, deps.git ?? gitRun);
			io.out(worktree.note);
			if (existing) {
				if (goal || doneWhen || values.plan) io.out(`Task ${id} exists: its goal and Done when stay as the record has them.`);
			} else {
				const project = loadProject(worktree.path);
				if (!project) throw new KalfaError(`${worktree.path} is not a repository`);
				io.out(`Task ${id} started: ${startTask(project, id, { goal, doneWhen: doneWhen!, plan: values.plan })}`);
			}
			// Only the first agent continues the Task: two sessions never share one Task Record.
			const lead = tabs.findIndex((tab) => 'agent' in tab);
			const plans = tabs.map((tab, n) => ({ title: tabTitle(tab, label, id), cwd: worktree.path, tab, prompt: n === lead ? successorPrompt(id) : undefined }));
			io.out(herdr(() => openTabs(exec, sessions, label, workspace, plans)).join('\n'));
			return 0;
		},
	};
}
