// Starts the next session in a new Herdr tab, so the Operator sees it live
// instead of attaching to a background session. The tab goes into the
// project's workspace (its label is the repository's folder name), is named
// after the Task, and gets focus. Every id comes from Herdr's JSON answers: a
// session started in the background inherits the HERDR_* variables of an old
// pane, so `--current` and HERDR_PANE_ID would point there.
import { accessSync, constants } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { basename, delimiter, join } from 'node:path';
import type { SessionLaunch } from '../../src/adapters/adapter.ts';
import type { Launcher } from './successor.ts';

/** Runs the herdr CLI and returns its stdout; throws on a non-zero exit. */
export type HerdrExec = (args: string[]) => string;

export const herdrCli: HerdrExec = (args) => execFileSync('herdr', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

/** A step before `agent start` failed, so no session started and another launcher may run. */
export class HerdrSetupError extends Error {}

/** A harness needs longer than Herdr's 30 s default when the machine is busy. */
export const START_TIMEOUT_MS = 60_000;

const NAME_LIMIT = 32;

interface Opened {
	workspace: string;
	tab: string;
	pane: string;
}

function isExecutable(path: string): boolean {
	try {
		accessSync(path, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

/** The command runs inside a Herdr pane and the herdr CLI is on PATH. */
export function inHerdr(env: NodeJS.ProcessEnv): boolean {
	return env.HERDR_ENV === '1' && (env.PATH ?? '').split(delimiter).some((dir) => dir !== '' && isExecutable(join(dir, 'herdr')));
}

/** A name Herdr accepts (`[a-z][a-z0-9_-]{0,31}`) and no live agent has. */
export function agentName(topic: string, taken: Set<string>): string {
	const slug = topic.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^[^a-z]+/, '');
	const base = (slug || 'next').slice(0, NAME_LIMIT).replace(/[-_]+$/, '');
	if (!taken.has(base)) return base;
	for (let n = 2; ; n++) {
		const suffix = `-${n}`;
		const name = `${base.slice(0, NAME_LIMIT - suffix.length).replace(/[-_]+$/, '')}${suffix}`;
		if (!taken.has(name)) return name;
	}
}

export const errorText = (error: unknown) => {
	const { stderr, message } = error as { stderr?: string | Buffer; message?: string };
	return String(stderr || message || error).trim();
};

const parse = (output: string) => JSON.parse(output) as { result: Record<string, unknown> };

const idOf = (value: unknown, key: string): string => {
	const id = typeof value === 'string' ? value : (value as Record<string, unknown> | undefined)?.[key];
	if (typeof id !== 'string') throw new Error(`no ${key} in the herdr answer`);
	return id;
};

/** A new tab in the project's workspace, or a new workspace when the project has none. */
function openTab(exec: HerdrExec, cwd: string, project: string, title: string): Opened {
	const { workspaces } = parse(exec(['workspace', 'list'])).result as { workspaces: { workspace_id: string; label: string }[] };
	const existing = workspaces.find((w) => w.label === project);
	if (existing) {
		const { result } = parse(exec(['tab', 'create', '--workspace', existing.workspace_id, '--cwd', cwd, '--label', title, '--no-focus']));
		return { workspace: existing.workspace_id, tab: idOf(result.tab, 'tab_id'), pane: idOf(result.root_pane, 'pane_id') };
	}
	const { result } = parse(exec(['workspace', 'create', '--cwd', cwd, '--label', project, '--no-focus']));
	const opened = { workspace: idOf(result.workspace, 'workspace_id'), tab: idOf(result.tab, 'tab_id'), pane: idOf(result.root_pane, 'pane_id') };
	exec(['tab', 'rename', opened.tab, title]);
	return opened;
}

function liveNames(exec: HerdrExec): Set<string> {
	const { agents } = parse(exec(['agent', 'list'])).result as { agents: { name?: string }[] };
	return new Set(agents.flatMap((a) => (a.name ? [a.name] : [])));
}

/** Focus is a convenience: a failure is reported, never fatal, since the session runs. */
function focus(exec: HerdrExec, opened: Opened): string {
	try {
		exec(['workspace', 'focus', opened.workspace]);
		exec(['tab', 'focus', opened.tab]);
		return 'focus moved there';
	} catch (error) {
		return `focus did not move (${errorText(error)})`;
	}
}

/** `kind` is the harness as Herdr names it (`herdr agent start --kind`); kalfa's Adapter names match. */
export function herdrTab(kind: string, session: SessionLaunch, exec: HerdrExec = herdrCli): Launcher {
	return (launch) => {
		const project = basename(launch.cwd);
		let opened: Opened;
		let agent: string;
		try {
			opened = openTab(exec, launch.cwd, project, launch.name);
			agent = agentName(launch.name, liveNames(exec));
		} catch (error) {
			throw new HerdrSetupError(`Herdr tab setup failed: ${errorText(error)}`);
		}
		const where = `tab "${launch.name}" (${opened.tab}) in workspace ${project} (${opened.workspace})`;
		try {
			exec(['agent', 'start', agent, '--kind', kind, '--pane', opened.pane, '--timeout', String(START_TIMEOUT_MS), '--', ...session.interactive(launch)]);
		} catch (error) {
			const text = errorText(error);
			// Blocked at start: the harness runs and waits at a question, most often the trust prompt of a new folder.
			if (text.includes('agent_not_ready')) {
				return `${kind} started as agent ${agent} in ${where}, but waits at a prompt: accept the trust prompt (or answer it) in that tab; ${focus(exec, opened)}.`;
			}
			// After `agent start`, an error does not prove that no session started.
			throw new Error(`herdr agent start failed in ${where}; a session may run there, so look before starting another: ${text}`);
		}
		return `Started agent ${agent} (${kind}) in ${where}; ${focus(exec, opened)}.`;
	};
}
