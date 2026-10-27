// The meter's state per session, in the machine's cache: a session belongs
// to the Operator, not to the repository. Old states are pruned.
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { MeterState } from './guard.ts';

const STATE_DAYS = 14;

export function stateDir(env: NodeJS.ProcessEnv): string {
	const cache = env.XDG_CACHE_HOME || join(env.HOME || homedir(), '.cache');
	return join(cache, 'kalfa', 'meter');
}

const statePath = (dir: string, sessionId: string) => join(dir, `${sessionId.replace(/[^\w-]/g, '_')}.json`);

export function readState(dir: string, sessionId: string): MeterState {
	try {
		return JSON.parse(readFileSync(statePath(dir, sessionId), 'utf8')) as MeterState;
	} catch {
		return { level: 0 };
	}
}

export function writeState(dir: string, sessionId: string, state: MeterState, now = Date.now()): void {
	mkdirSync(dir, { recursive: true });
	writeFileSync(statePath(dir, sessionId), JSON.stringify(state));
	for (const name of readdirSync(dir)) {
		const path = join(dir, name);
		if (now - statSync(path).mtimeMs > STATE_DAYS * 86_400_000) rmSync(path, { force: true });
	}
}
