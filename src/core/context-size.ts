// The size of the last session start's context, per repository and harness,
// against the harness's cap on one hook's context. The hook records it;
// `kalfa doctor` reports it. It lives in the cache folder: losing it only
// means doctor waits for the next session start.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { machineCacheDir } from './machine-paths.ts';

export interface ContextSize {
	/** Characters of context the session start gave the agent. */
	chars: number;
	/** The harness's cap on one hook's context; `undefined` when it has none. */
	cap?: number;
	/** ISO time of the session start. */
	at: string;
}

/** Per repository root (`''` outside one), per harness. */
type SizeTable = Record<string, Record<string, ContextSize>>;

const tablePath = (env: NodeJS.ProcessEnv) => join(machineCacheDir(env), 'session-context.json');

function readTable(env: NodeJS.ProcessEnv): SizeTable {
	try {
		const path = tablePath(env);
		return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as SizeTable) : {};
	} catch {
		return {};
	}
}

/** Records the size; a cache that cannot be written is skipped. */
export function recordContextSize(env: NodeJS.ProcessEnv, root: string | undefined, harness: string, size: ContextSize): void {
	try {
		const table = readTable(env);
		table[root ?? ''] = { ...table[root ?? ''], [harness]: size };
		mkdirSync(dirname(tablePath(env)), { recursive: true });
		writeFileSync(tablePath(env), `${JSON.stringify(table, null, 2)}\n`);
	} catch {
		// The cache is optional.
	}
}

export const contextSizes = (env: NodeJS.ProcessEnv, root: string | undefined): Record<string, ContextSize> => readTable(env)[root ?? ''] ?? {};

/** A share of the cap past which doctor warns, before the harness cuts the context. */
export const NEAR_CAP = 0.9;

/** The line doctor shows for one harness. */
export function contextSizeLine(harness: string, size: ContextSize): string {
	const when = size.at.slice(0, 16).replace('T', ' ');
	if (size.cap === undefined) return `${harness}: ${size.chars} characters at the last session start (${when}); the harness has no cap`;
	const over = size.chars > size.cap;
	const near = !over && size.chars > size.cap * NEAR_CAP;
	const verdict = over ? 'problem: over the cap, so the agent sees only its start' : near ? 'warning: near the cap' : 'within the cap';
	return `${harness}: ${size.chars} of ${size.cap} characters at the last session start (${when}); ${verdict}`;
}
