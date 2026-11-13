// A Checkpoint: the summary a harness wrote when it compacted a session that
// works on a Task. It is kept next to the Task Record, in
// `<repo>/.kalfa/checkpoints/<task>/<time>-<trigger>.md`, one file each, not in
// the record: a summary is long and can hold Markdown headings of its own.
// Only the newest few are kept; the last one tells where the session stood.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import { stateDir, statePath } from './private-dir.ts';

/** How many Checkpoints of one Task are kept. */
export const CHECKPOINTS_KEPT = 5;

export interface Checkpoint {
	task: string;
	trigger: string;
	/** ISO time of the compaction. */
	at: string;
	session?: string;
	summary: string;
	path: string;
}

export function checkpointsDir(root: string, task: string): string {
	return statePath(root, 'checkpoints', task);
}

/** `2026-11-12T20:05:07.123Z` → `20261112T200507Z`: sorts by time, safe in a file name. */
const stamp = (at: string) => `${at.slice(0, 19).replace(/[-:]/g, '')}Z`;
const safe = (word: string) => word.replace(/[^A-Za-z0-9_-]+/g, '-') || 'unknown';

/** Writes the Checkpoint and drops the oldest beyond CHECKPOINTS_KEPT; refused unless git ignores `.kalfa/`. Returns its path. */
export function writeCheckpoint(root: string, checkpoint: Omit<Checkpoint, 'path'>): string {
	stateDir(root);
	const dir = checkpointsDir(root, checkpoint.task);
	mkdirSync(dir, { recursive: true });
	const path = join(dir, `${stamp(checkpoint.at)}-${safe(checkpoint.trigger)}.md`);
	const header = { task: checkpoint.task, trigger: checkpoint.trigger, at: checkpoint.at, ...(checkpoint.session ? { session: checkpoint.session } : {}) };
	writeFileSync(path, `---\n${stringify(header).trimEnd()}\n---\n\n${checkpoint.summary.trim()}\n`);
	for (const old of files(dir).slice(0, -CHECKPOINTS_KEPT)) rmSync(join(dir, old));
	return path;
}

const files = (dir: string) => (existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith('.md')).sort() : []);

/** The newest Checkpoint of the Task, or `undefined` when it has none or the file cannot be read. */
export function lastCheckpoint(root: string, task: string): Checkpoint | undefined {
	const dir = checkpointsDir(root, task);
	const name = files(dir).at(-1);
	if (!name) return undefined;
	const path = join(dir, name);
	const match = /^---\n([\s\S]*?)\n---\n\n?([\s\S]*)$/.exec(readFileSync(path, 'utf8'));
	if (!match) return undefined;
	const header = parse(match[1]!) as Partial<Checkpoint> | null;
	if (!header?.trigger || !header.at) return undefined;
	return { task, trigger: String(header.trigger), at: String(header.at), session: header.session, summary: match[2]!.trim(), path };
}
