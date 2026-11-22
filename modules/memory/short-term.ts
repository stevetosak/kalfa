// Short-term memory at session start (ADR 0003): the closed Task Records that
// missed their Cleanup, and the open Tasks whose records have had no write for
// a number of Active days. Both are only reported: the next Task close takes
// in a missed Cleanup, and the Operator decides about an idle Task.
import { statSync } from 'node:fs';
import { localDay } from '../../src/core/active-days.ts';
import type { TaskRecord } from '../../src/core/task-record.ts';

/** How many Task ids a session start line names before "and N more". */
const IDS_SHOWN = 3;

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** The closed records that are not reconciled, the oldest close first. */
export function missedCleanups(records: readonly TaskRecord[]): TaskRecord[] {
	return records
		.filter((record) => record.header.status === 'closed' && !record.header.reconciled)
		.sort((a, b) => (a.header.closed ?? '').localeCompare(b.header.closed ?? '') || a.id.localeCompare(b.id));
}

/** What the idle check reads about the repository. */
export interface IdleFacts {
	/** The repository's Active days, sorted. */
	activeDays: readonly string[];
	/** How many Active days after its last write make an open Task idle. */
	days: number;
	/** The local day (YYYY-MM-DD) of the record's last write. */
	lastWrite: (record: TaskRecord) => string;
}

/** An open Task whose record has had no write for `days` Active days after the day `since`. */
export interface IdleTask {
	id: string;
	since: string;
	days: number;
}

/** The open Tasks with no write to their record for at least the set number of Active days, the longest idle first. */
export function idleTasks(records: readonly TaskRecord[], facts: IdleFacts): IdleTask[] {
	return records
		.filter((record) => record.header.status === 'open')
		.map((record) => {
			const since = facts.lastWrite(record);
			return { id: record.id, since, days: facts.activeDays.filter((day) => day > since).length };
		})
		.filter((task) => task.days >= facts.days)
		.sort((a, b) => b.days - a.days || a.id.localeCompare(b.id));
}

/** The local day of the record file's last write: a Section close or the Task close writes it; a Checkpoint does not, since an idle compaction writes one with no work. */
export const lastWriteDay = (record: TaskRecord): string => localDay(statSync(record.path).mtime);

const someOf = (items: readonly string[]) =>
	items.length > IDS_SHOWN ? `${items.slice(0, IDS_SHOWN).join(', ')} and ${items.length - IDS_SHOWN} more` : items.join(', ');

/** The session start lines for the agent, and the summary the Operator sees. */
export function shortTermReport(missed: readonly TaskRecord[], idle: readonly IdleTask[], idleDays: number): { context?: string; summary?: string } {
	const lines = [
		...(missed.length
			? [`Closed Task Records that missed their Cleanup (not reconciled): ${someOf(missed.map((r) => r.id))}. The next Task close takes in their findings with its own Cleanup.`]
			: []),
		...(idle.length
			? [
					`Open Tasks with no write to their record for ${idleDays} or more Active days: ${someOf(idle.map((t) => `${t.id} (last write ${t.since}, ${plural(t.days, 'Active day')} since)`))}. Tell the Operator; the Operator decides whether to close each one or go on with it.`,
				]
			: []),
	];
	const summary = [
		...(missed.length ? [plural(missed.length, 'missed Cleanup')] : []),
		...(idle.length ? [`${plural(idle.length, 'idle Task')}: ${someOf(idle.map((t) => t.id))}`] : []),
	];
	return { context: lines.length ? lines.join('\n') : undefined, summary: summary.length ? summary.join(' · ') : undefined };
}
