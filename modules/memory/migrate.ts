// The Migration of a repository's Task Records (ADR 0003; Plan memory
// revision, Part 5): each closed record from before the Cleanup is marked
// reconciled, since its findings went to the inbox through the old path, and
// the window then moves the records outside it to the archive. It runs once
// per repository. A later run would also mark a record that missed its
// Cleanup, so the dry run names each record before the real one.
import { localDay } from '../../src/core/active-days.ts';
import type { Project } from '../../src/core/project.ts';
import { listRecords, type TaskRecord, writeRecord } from '../../src/core/task-record.ts';
import { archiveOutsideWindow, outsideWindow } from './window.ts';

/** The ids the Migration marks reconciled, and the ids it then moves to the archive; a failed move keeps the marks. */
export interface Migration {
	marked: string[];
	moved: string[];
	failure?: string;
}

const awaitsMark = (record: TaskRecord) => record.header.status === 'closed' && !record.header.reconciled;

const withMark = (record: TaskRecord, day: string): TaskRecord => ({ ...record, header: { ...record.header, reconciled: day } });

const ids = (records: readonly TaskRecord[]) => records.map((record) => record.id);

/** What the Migration would mark and move now; it writes nothing. */
export function migrationPlan(project: Project, days: number, now = new Date()): Migration {
	const records = listRecords(project.root);
	const marked = records.map((record) => (awaitsMark(record) ? withMark(record, localDay(now)) : record));
	return { marked: ids(records.filter(awaitsMark)), moved: ids(outsideWindow(project.root, marked, days)) };
}

/**
 * Marks each closed record that has no mark reconciled, then moves the
 * records outside the window, with their Checkpoints, to the archive. A
 * failed move keeps the marks and every file, and is returned as the
 * failure: the next Task close moves the records.
 */
export function migrate(project: Project, home: string, days: number, now = new Date()): Migration {
	const waiting = listRecords(project.root).filter(awaitsMark);
	for (const record of waiting) writeRecord(project.root, withMark(record, localDay(now)));
	try {
		return { marked: ids(waiting), moved: archiveOutsideWindow(project, home, days) };
	} catch (error) {
		return { marked: ids(waiting), moved: [], failure: (error as Error).message };
	}
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** The lines that report a Migration, or the dry run's plan of one. */
export function migrationLines({ marked, moved, failure }: Migration, dryRun: boolean): string[] {
	const [mark, move] = dryRun ? ['Would mark', 'Would move'] : ['Marked', 'Moved'];
	return [
		marked.length ? `${mark} ${plural(marked.length, 'closed Task Record')} reconciled: ${marked.join(', ')}` : 'No closed Task Record waits for its mark.',
		...(failure
			? [`The move to the archive failed, so the records stay in .kalfa; the next Task close moves them: ${failure}`]
			: [moved.length ? `${move} ${plural(moved.length, 'Task Record')} with ${moved.length === 1 ? 'its' : 'their'} Checkpoints to the archive in the Memory home: ${moved.join(', ')}` : 'No Task Record is outside the Short-term window.']),
	];
}
