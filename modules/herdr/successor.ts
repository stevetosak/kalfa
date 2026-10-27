// The successor: a new session that continues an open Task from its Task
// Record, so the work goes on with a clean context. Inside Herdr it starts in
// a new tab the Operator sees (launcher.ts); elsewhere as a background session
// of the harness. The prompt names the Task only: the new session reads the
// Handoff view itself, so nothing is copied that can go stale.
import { execFileSync } from 'node:child_process';
import type { Adapter, SessionStart } from '../../src/adapters/adapter.ts';
import { KalfaError } from '../../src/core/errors.ts';
import type { LimitVerdict } from '../../src/core/usage-limits.ts';
import { HerdrSetupError, herdrTab, inHerdr } from './launcher.ts';

export interface Launch extends SessionStart {
	/** The folder the session starts in: the repository root. */
	cwd: string;
}

/** Starts a session and returns what the starter printed. */
export type Launcher = (launch: Launch) => string;

export function successorPrompt(task: string): string {
	return [
		`Continue the kalfa Task ${task}: run \`kalfa task show --handoff --task ${task}\` and do the work its Next part gives, under its rules.`,
		'Record each logical Section with `kalfa section close`; close the Task with `kalfa task close` when its goal holds.',
	].join(' ');
}

/** The harness's own background session; `undefined` when it has none. */
export function backgroundSession(adapter: Adapter): Launcher | undefined {
	const session = adapter.session;
	const args = session?.background;
	if (!session || !args) return undefined;
	return (launch) => execFileSync(session.program, args(launch), { cwd: launch.cwd, encoding: 'utf8' }).trim();
}

/** Inside Herdr a new tab; outside it, or when the tab cannot be made, a background session. */
export function defaultLauncher(adapter: Adapter, env: NodeJS.ProcessEnv, herdr?: Launcher, background = backgroundSession(adapter)): Launcher {
	const session = adapter.session;
	if (!session) throw new KalfaError(`kalfa cannot start a ${adapter.name} session; start one yourself and give it the prompt below`);
	const tab = inHerdr(env) ? (herdr ?? herdrTab(adapter.name, session)) : undefined;
	const fallback = (launch: Launch, why: string) => {
		if (!background) throw new KalfaError(`${why}, and ${adapter.name} has no background sessions; start one in ${launch.cwd} on the prompt: ${launch.prompt}`);
		return background(launch);
	};
	if (!tab) return (launch) => fallback(launch, 'not inside Herdr');
	return (launch) => {
		try {
			return tab(launch);
		} catch (error) {
			if (!(error instanceof HerdrSetupError)) throw error;
			return `${error.message}\nStarted in the background instead:\n${fallback(launch, error.message)}`;
		}
	};
}

export interface ContinueOptions {
	task: string;
	/** The repository root. */
	cwd: string;
	name?: string;
	model?: string;
	force?: boolean;
	launcher: Launcher;
	limits: () => LimitVerdict;
}

export type ContinueResult = { launched: true; output: string; note: string } | { launched: false; reason: string };

/** Checks the usage limits, then starts the session that continues `task`. */
export function continueTask(options: ContinueOptions): ContinueResult {
	const verdict = options.limits();
	if (!verdict.ok && !options.force) return { launched: false, reason: `a usage limit is near: ${verdict.reason}` };
	const output = options.launcher({ cwd: options.cwd, name: options.name ?? options.task, prompt: successorPrompt(options.task), model: options.model });
	return { launched: true, output, note: verdict.ok ? verdict.note : `forced past: ${verdict.reason}` };
}
