// The Recap: where the work of a repository stood, for an Operator who comes
// back after days away. It joins what kalfa already keeps, with no model call:
// the Plan part, the last Task (goal, finish line, Sections, recent Decisions,
// Next), its last Checkpoint, the commits since the record was last written,
// and the other open Tasks. A session start shows it unasked when the
// repository has had no activity for some days; `/where-was-i` tells it as a
// line of thinking.
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { checkpointsDir, lastCheckpoint } from './checkpoint.ts';
import { commitsSince, currentBranch, headTime } from './git.ts';
import { findPlans, isOpenPlan, openAnywhere, parsePlan, planSummary, progressOf } from './plans.ts';
import { PRIVATE_DIR, privateDir } from './private-dir.ts';
import { listRecords, recentDecisions, type TaskRecord, taskIdOf } from './task-record.ts';

/** The Decisions of at most this many Sections, within DECISIONS_MAX characters. */
const DECISION_SECTIONS = 3;
const DECISIONS_MAX = 2500;
const COMMITS_MAX = 10;
const DAY_MS = 24 * 60 * 60 * 1000;
const SESSION_STAMP = 'last-session';

const mtime = (path: string) => statSync(path).mtimeMs;
const newest = (times: (number | undefined)[]) => times.reduce<number | undefined>((a, b) => (b === undefined || (a !== undefined && a >= b) ? a : b), undefined);

/** The time of the last work in the repository: the HEAD commit, a Task Record or a Checkpoint written. */
export function lastWork(root: string): Date | undefined {
	const records = listRecords(root).map((r) => mtime(r.path));
	const base = join(root, PRIVATE_DIR, 'checkpoints');
	const checkpoints = existsSync(base) ? readdirSync(base).flatMap((task) => readdirSync(checkpointsDir(root, task)).map((f) => mtime(join(checkpointsDir(root, task), f)))) : [];
	const time = newest([headTime(root)?.getTime(), ...records, ...checkpoints]);
	return time === undefined ? undefined : new Date(time);
}

/** The last work, or the last session start when that is newer: a session with no commit is still activity. */
export function lastActivity(root: string): Date | undefined {
	const stamp = join(root, PRIVATE_DIR, SESSION_STAMP);
	const time = newest([lastWork(root)?.getTime(), existsSync(stamp) ? mtime(stamp) : undefined]);
	return time === undefined ? undefined : new Date(time);
}

/** Records that a session started now; skipped where git does not ignore `.kalfa/`. */
export function markSession(root: string): void {
	try {
		writeFileSync(join(privateDir(root), SESSION_STAMP), `${new Date().toISOString()}\n`);
	} catch {
		// No private folder: no stamp, and the next start counts from the last work.
	}
}

/** Whole days between `since` and `now`. */
export const idleDays = (since: Date, now: Date) => Math.floor((now.getTime() - since.getTime()) / DAY_MS);

const relative = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

/** `3 days ago`, `yesterday`, `5 hours ago`. */
export function ago(then: Date, now: Date): string {
	const minutes = Math.round((then.getTime() - now.getTime()) / 60_000);
	if (Math.abs(minutes) < 60) return relative.format(minutes, 'minute');
	if (Math.abs(minutes) < 24 * 60) return relative.format(Math.round(minutes / 60), 'hour');
	return relative.format(Math.round(minutes / (24 * 60)), 'day');
}

/** `2026-11-12 20:05`, in local time. */
const when = (time: Date) => time.toLocaleString('sv-SE', { dateStyle: 'short', timeStyle: 'short' });

const firstLine = (text: string | undefined) => text?.split('\n').find((line) => line.trim())?.trim();

/** The Task the Recap is about: the named one, else the branch's, else the one whose record was written last. */
export function recapTask(root: string, id?: string): TaskRecord | undefined {
	const records = listRecords(root);
	if (id) return records.find((r) => r.id === taskIdOf(id));
	const branch = currentBranch(root);
	const own = branch ? records.find((r) => r.id === taskIdOf(branch)) : undefined;
	return own ?? [...records].sort((a, b) => mtime(b.path) - mtime(a.path))[0];
}

const clip = (text: string, max = 100) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** One line per part of the Task's Plan: its progress and next step. A Task does not record its part; its goal names it. */
function planLines(root: string, path: string): string[] {
	const file = join(root, path);
	const plan = existsSync(file) ? parsePlan(readFileSync(file, 'utf8'), path) : undefined;
	if (!plan) return [`Plan: ${path} (not found)`];
	return [
		`Plan: ${plan.title} (${plan.status}; ${path})`,
		...plan.parts.map((part) => {
			const { done, total } = progressOf(part.steps);
			const [next] = openAnywhere(part.steps);
			return `  ${part.group ?? '(above the first heading)'}: ${next ? `${done} of ${total} steps done; next: ${clip(next.label)}` : 'done'}`;
		}),
	];
}

function taskLines(record: TaskRecord): string[] {
	const { header, sections } = record;
	const lines = [`Task ${record.id} (${header.status}, started ${header.started}${header.closed ? `, closed ${header.closed}` : ''}; ${record.path})`, `  Goal: ${header.goal}`];
	if (header['done-when']) lines.push(`  Done when: ${header['done-when']}`);
	const answer = firstLine(record.close?.get('Done when'));
	if (answer) lines.push(`  At close: ${answer}`);
	lines.push(`  Sections: ${sections.length ? sections.map((s) => s.title).join('; ') : 'none closed yet'}`);
	const decisions = recentDecisions(sections, DECISIONS_MAX, DECISION_SECTIONS);
	lines.push(...(decisions.length ? ['  Decisions (the last Sections):', ...decisions.map((d) => d.replace(/^/gm, '  '))] : ['  Decisions: none recorded']));
	lines.push(`  Next: ${record.close?.get('Next') ?? sections.at(-1)?.parts.get('Next') ?? 'not recorded'}`);
	return lines;
}

/**
 * The Recap of the repository at `root`, as plain text. `plans` are the
 * project's Plan globs, shown when the Task names no Plan.
 */
export function recapView(root: string, plans: readonly string[], options: { task?: string; now?: Date } = {}): string {
	const now = options.now ?? new Date();
	const record = recapTask(root, options.task);
	const work = lastWork(root);
	const blocks: string[][] = [[`Recap of ${basename(root)}${work ? `: last work ${ago(work, now)} (${when(work)})` : ''}`]];

	if (record?.header.plan) blocks.push(planLines(root, record.header.plan));
	else if (plans.length) {
		const open = findPlans(root, plans).plans.filter(isOpenPlan);
		if (open.length) blocks.push(['Open Plans:', ...open.map(planSummary)]);
	}

	if (!record) {
		blocks.push(['No Task Records; start one with: kalfa task start "<goal>" --done-when "<finish line>"']);
		return blocks.map((b) => b.join('\n')).join('\n\n');
	}
	blocks.push(taskLines(record));

	const checkpoint = lastCheckpoint(root, record.id);
	blocks.push([checkpoint ? `Last Checkpoint: ${when(new Date(checkpoint.at))} (${checkpoint.trigger} compaction, ${ago(new Date(checkpoint.at), now)}): ${checkpoint.path}` : 'Last Checkpoint: none']);

	const since = new Date(mtime(record.path));
	const commits = commitsSince(root, since, COMMITS_MAX);
	blocks.push([
		`Commits since the record was last written (${when(since)}):`,
		...(commits.lines.length ? commits.lines.map((c) => `  ${c}`) : ['  none']),
		...(commits.more ? [`  … and ${commits.more} more`] : []),
	]);

	const others = listRecords(root).filter((r) => r.header.status === 'open' && r.id !== record.id);
	if (others.length) {
		blocks.push([
			'Other open Tasks:',
			...others.map((r) => {
				const next = firstLine(r.sections.at(-1)?.parts.get('Next'));
				return `  - ${r.id}: ${r.header.goal}${next ? `\n    Next: ${next}` : ''}`;
			}),
		]);
	}
	return blocks.map((b) => b.join('\n')).join('\n\n');
}
