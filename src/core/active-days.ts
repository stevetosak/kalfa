// Active days (ADR 0003): the days with a commit or a session start in a
// repository. The age of a closed Task counts in them, so the days a project
// lies idle do not age its Tasks. git holds the commit days; kalfa records the
// session start days in the repository's state, `.kalfa/active-days`, one local
// date (YYYY-MM-DD) per line, shared by every checkout of the repository. Two
// sessions that start at the same moment can both write the day; readers take
// each day once.
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { commitDays } from './git.ts';
import { stateDir, statePath } from './private-dir.ts';

const ACTIVE_DAYS = 'active-days';
const DAY = /^\d{4}-\d{2}-\d{2}$/;

const pad = (n: number) => String(n).padStart(2, '0');

/** The local date of `time`, as YYYY-MM-DD. */
export const localDay = (time: Date): string => `${time.getFullYear()}-${pad(time.getMonth() + 1)}-${pad(time.getDate())}`;

/** The lines of the session start days recorded for the repository at `root`. */
function sessionDays(root: string): string[] {
	const path = statePath(root, ACTIVE_DAYS);
	return existsSync(path) ? readFileSync(path, 'utf8').split('\n') : [];
}

/**
 * Records that a session started on the local day of `now`, once per day.
 * Where git does not ignore `.kalfa/` nothing is written. It never throws: the
 * session report matters more than one day's record, and the commit days still count.
 */
export function markActiveDay(root: string, now = new Date()): void {
	try {
		const day = localDay(now);
		if (sessionDays(root).includes(day)) return;
		appendFileSync(join(stateDir(root), ACTIVE_DAYS), `${day}\n`);
	} catch {
		// No private folder, or no write: that day's record is lost.
	}
}

/**
 * The Active days of the repository at `root`, sorted and each once: the
 * recorded session start days and the local days of its commits on every
 * branch. With `since` (YYYY-MM-DD), only that day and the later ones.
 */
export function activeDays(root: string, since?: string): string[] {
	const days = new Set([...sessionDays(root), ...commitDays(root, since)]);
	return [...days].filter((day) => DAY.test(day) && (since === undefined || day >= since)).sort();
}
