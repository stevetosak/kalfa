// The harness's usage limits, as its status line last saw them. A status line
// tap saves them (the `meter` Module); a session that starts another session
// reads them first, because a chain of sessions spends the limit with no one
// watching. Without a tap the limits are unknown, and that is not a refusal.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { machineCacheDir } from './machine-paths.ts';

/** At this share of a window, a new session is refused unless forced. */
export const LIMIT_PERCENT = 85;
/** Saved limits older than this say nothing about now. */
export const STALE_MS = 30 * 60 * 1000;

const window = z.looseObject({ used_percentage: z.number().optional(), resets_at: z.number().optional() });
const savedSchema = z.looseObject({ savedAt: z.number(), limits: z.record(z.string(), window) });

export type LimitWindow = z.infer<typeof window>;
export type SavedLimits = z.infer<typeof savedSchema>;

export type LimitVerdict = { ok: true; note: string } | { ok: false; reason: string };

export function limitsPath(env: NodeJS.ProcessEnv = process.env): string {
	return join(machineCacheDir(env), 'usage-limits.json');
}

/** Saves the windows by name (e.g. `five_hour`); written whole, so a reader never sees half a file. */
export function saveLimits(path: string, limits: Record<string, LimitWindow>, now = Date.now()): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(`${path}.tmp`, JSON.stringify({ savedAt: now, limits } satisfies SavedLimits));
	renameSync(`${path}.tmp`, path);
}

const resetText = (w: LimitWindow) => (w.resets_at ? `, resets ${new Date(w.resets_at * 1000).toLocaleString()}` : '');

export function checkLimits(path: string, now = Date.now(), limit = LIMIT_PERCENT): LimitVerdict {
	if (!existsSync(path)) return { ok: true, note: 'usage limits unknown (nothing saved them)' };
	let data: unknown;
	try {
		data = JSON.parse(readFileSync(path, 'utf8'));
	} catch {
		data = undefined;
	}
	const saved = savedSchema.safeParse(data);
	if (!saved.success) return { ok: true, note: `usage limits unknown (${path} is not a limits file)` };
	if (now - saved.data.savedAt > STALE_MS) return { ok: true, note: 'usage limits unknown (the saved limits are stale)' };
	const windows = Object.entries(saved.data.limits);
	const over = windows.filter(([, w]) => (w.used_percentage ?? 0) >= limit);
	if (over.length) return { ok: false, reason: over.map(([name, w]) => `${name} at ${w.used_percentage}%${resetText(w)}`).join('; ') };
	return { ok: true, note: windows.map(([name, w]) => `${name} ${w.used_percentage ?? '?'}%`).join(', ') || 'usage limits unknown' };
}
