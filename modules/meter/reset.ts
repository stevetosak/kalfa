// Auto mode's Reset: a Section close, a /clear and a continue word in one
// session, typed into its Herdr pane without the Operator. `kalfa section
// close` past the compact point starts a detached waiter (`kalfa meter
// reset-wait`), because the session cannot clear itself while its turn runs:
// the waiter waits for the pane to go idle or done, types /clear, waits for
// Herdr to report a new session id (Herdr reports /clear as a stall although
// it clears, so the exit code proves nothing), carries the meter state to the
// new id, and types "continue", which loads the Task's Handoff. Each Reset,
// skip and failure goes to resets.jsonl with the facts known then; the usage
// report measures its cost and saving from the transcripts later.
import { spawn } from 'node:child_process';
import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { errorText, type HerdrExec } from '../herdr/launcher.ts';
import { readState, writeState } from './state.ts';

/** How long the waiter waits for the turn to end; a pending claim older than this is stale. */
export const TURN_WAIT_MS = 2 * 60 * 60 * 1000;
/** How long /clear may take to show a new session id. */
export const CLEAR_WAIT_MS = 60_000;
const POLL_MS = 500;

/** What `section close` hands the waiter. */
export const resetJobSchema = z.strictObject({
	pane: z.string().min(1),
	session: z.string().min(1),
	repo: z.string(),
	task: z.string(),
	model: z.string(),
	context: z.number(),
	payback: z.number().optional(),
});

export type ResetJob = z.infer<typeof resetJobSchema>;

const entrySchema = z.object({
	at: z.number(),
	kind: z.enum(['reset', 'skip', 'failed']),
	repo: z.string(),
	task: z.string(),
	model: z.string(),
	/** The context of the session's last request before the Reset. */
	context: z.number(),
	/** The session before the Reset; the new one in `to`. */
	from: z.string(),
	to: z.string().optional(),
	/** The payback estimate the agent was given, in requests. */
	payback: z.number().optional(),
	/** A skip: the agent's estimate of the requests left. */
	estimate: z.number().optional(),
	reason: z.string().optional(),
});

/** One line of resets.jsonl. */
export type ResetEntry = z.infer<typeof entrySchema>;

export const resetLogPath = (dir: string) => join(dir, 'resets.jsonl');

export function logReset(dir: string, entry: ResetEntry): void {
	mkdirSync(dir, { recursive: true });
	appendFileSync(resetLogPath(dir), `${JSON.stringify(entry)}\n`);
}

/** Every entry of the log; a broken line is left out. */
export function readResets(dir: string): ResetEntry[] {
	let text: string;
	try {
		text = readFileSync(resetLogPath(dir), 'utf8');
	} catch {
		return [];
	}
	return text.split('\n').flatMap((line) => {
		try {
			const parsed = entrySchema.safeParse(JSON.parse(line));
			return parsed.success ? [parsed.data] : [];
		} catch {
			return [];
		}
	});
}

const pendingPath = (dir: string, pane: string) => join(dir, `reset-${pane.replace(/[^\w-]/g, '_')}.pending`);

/** Claims the pane for one waiter: false when another waiter has it and is not stale. */
export function claimPending(dir: string, pane: string, now: number): boolean {
	mkdirSync(dir, { recursive: true });
	const path = pendingPath(dir, pane);
	try {
		if (now - statSync(path).mtimeMs < TURN_WAIT_MS) return false;
		rmSync(path, { force: true });
	} catch {
		// No claim yet.
	}
	try {
		closeSync(openSync(path, 'wx'));
		return true;
	} catch {
		return false;
	}
}

export const releasePending = (dir: string, pane: string) => rmSync(pendingPath(dir, pane), { force: true });

/** The session id Herdr reports for the agent in `pane`. */
export function paneSession(exec: HerdrExec, pane: string): string | undefined {
	const answer = JSON.parse(exec(['agent', 'get', pane])) as { result?: { agent?: { agent_session?: { value?: unknown } } } };
	const value = answer.result?.agent?.agent_session?.value;
	return typeof value === 'string' ? value : undefined;
}

export interface WaiterDeps {
	exec: HerdrExec;
	/** The meter's state folder: the meter state and the log. */
	dir: string;
	now: () => number;
	sleep: (ms: number) => void;
}

/** The Reset itself, run by the waiter; the entry it returns is also logged. */
export function runReset(job: ResetJob, deps: WaiterDeps): ResetEntry {
	const { exec, dir } = deps;
	const base = { at: deps.now(), repo: job.repo, task: job.task, model: job.model, context: job.context, from: job.session, ...(job.payback !== undefined && { payback: job.payback }) };
	const fail = (reason: string): ResetEntry => ({ ...base, kind: 'failed', reason });
	let entry: ResetEntry;
	try {
		entry = steps();
	} catch (error) {
		entry = fail(errorText(error));
	} finally {
		releasePending(dir, job.pane);
	}
	logReset(dir, entry);
	return entry;

	function steps(): ResetEntry {
		try {
			exec(['agent', 'wait', job.pane, '--until', 'idle', '--until', 'done', '--timeout', String(TURN_WAIT_MS)]);
		} catch (error) {
			return fail(`the turn did not end: ${errorText(error)}`);
		}
		if (paneSession(exec, job.pane) !== job.session) return fail('the pane runs another session now; nothing typed');
		try {
			exec(['agent', 'prompt', job.pane, '/clear']);
		} catch {
			// Herdr reports /clear as a stall although it clears: the new session id is the proof.
		}
		const until = deps.now() + CLEAR_WAIT_MS;
		let next = paneSession(exec, job.pane);
		while (next === job.session && deps.now() < until) {
			deps.sleep(POLL_MS);
			next = paneSession(exec, job.pane);
		}
		if (!next || next === job.session) return fail('/clear showed no new session id');
		const { level: _, ...carried } = readState(dir, job.session);
		writeState(dir, next, { ...carried, level: 0 });
		try {
			exec(['agent', 'prompt', job.pane, 'continue']);
		} catch (error) {
			return { ...fail(`cleared, but "continue" was not sent: ${errorText(error)}`), to: next };
		}
		return { ...base, kind: 'reset', to: next };
	}
}

export const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** Starts `kalfa meter reset-wait` detached, so it outlives the command and the turn; its output goes to a log next to the state. */
export type SpawnWaiter = (job: ResetJob, dir: string) => void;

export const spawnWaiter: SpawnWaiter = (job, dir) => {
	mkdirSync(dir, { recursive: true });
	const log = openSync(join(dir, `reset-${job.pane.replace(/[^\w-]/g, '_')}.log`), 'w');
	const child = spawn(process.execPath, [...process.execArgv, process.argv[1]!, 'meter', 'reset-wait', JSON.stringify(job)], { detached: true, stdio: ['ignore', log, log] });
	child.unref();
	closeSync(log);
};
