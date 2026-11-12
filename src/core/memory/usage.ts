// The days a Memory record was last used: read with `kalfa memory show`, or
// returned by `kalfa memory search` (ADR 0002, amendment 2026-11-08). They
// rank the Loaded tier. They change on every read, so they live in the cache
// folder, one file per layer, never in the Memory home and its history; a
// lost or broken file only makes the ranking fall back to the confirmed date.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { machineCacheDir } from '../machine-paths.ts';
import type { Layer } from './home.ts';

/** Record id → the day (`YYYY-MM-DD`) it was last used. */
export type Usage = Readonly<Record<string, string>>;

const today = () => new Date().toLocaleDateString('sv-SE');

/** The usage file of a layer: `memory-usage/personal.json`, or `memory-usage/projects/<key>.json`. */
export function usagePath(layer: Layer, env: NodeJS.ProcessEnv = process.env): string {
	const name = layer.name === 'personal' ? 'personal' : join('projects', ...layer.label.split('/'));
	return join(machineCacheDir(env), 'memory-usage', `${name}.json`);
}

const DATE = /^\d{4}-\d\d-\d\d$/;

/** The layer's usage; empty when the file is missing or not valid. */
export function readUsage(layer: Layer, env: NodeJS.ProcessEnv = process.env): Usage {
	try {
		const parsed: unknown = JSON.parse(readFileSync(usagePath(layer, env), 'utf8'));
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
		return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === 'string' && DATE.test(entry[1])));
	} catch {
		return {};
	}
}

/**
 * Marks records of one layer as used today. It never fails the command that
 * calls it: the ranking is a convenience, the read is the work.
 */
export function markUsed(layer: Layer, ids: readonly string[], env: NodeJS.ProcessEnv = process.env, day = today()): void {
	if (!ids.length) return;
	const usage = { ...readUsage(layer, env) };
	if (ids.every((id) => usage[id] === day)) return;
	for (const id of ids) usage[id] = day;
	const path = usagePath(layer, env);
	try {
		mkdirSync(dirname(path), { recursive: true });
		const temp = `${path}.${process.pid}.tmp`;
		writeFileSync(temp, `${JSON.stringify(usage, null, '\t')}\n`);
		renameSync(temp, path);
	} catch {
		// A read-only cache costs only the ranking.
	}
}
