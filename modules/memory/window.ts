// The Short-term window (ADR 0003). A closed Task Record stays in the
// repository's state, with its Checkpoints, while open work may still need
// it: while its Plan is open, while an open Task Record names it, or while it
// closed fewer than N Active days ago, so the days a project lies idle do not
// age it. A record leaves only after its Cleanup (reconciled); leaving moves
// it and its Checkpoints to the project's folders in the Memory home, the
// archive, where search still finds it.
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { activeDays } from '../../src/core/active-days.ts';
import { checkpointsDir } from '../../src/core/checkpoint.ts';
import { KalfaError } from '../../src/core/errors.ts';
import { commitHome, projectCheckpointsDir, projectKey, projectTasksDir } from '../../src/core/memory/home.ts';
import { isOpenPlan, parsePlan } from '../../src/core/plans.ts';
import type { Project } from '../../src/core/project.ts';
import { listRecords, type TaskRecord } from '../../src/core/task-record.ts';

/** Why a Task Record stays in the repository; a record with none leaves for the archive. */
export type StayReason = 'open' | 'not reconciled' | 'plan open' | 'named by an open Task' | 'recent';

/** What the window reads about the repository. */
export interface WindowFacts {
	/** Whether the Plan at this path (from the repository root) is open. */
	planOpen: (path: string) => boolean;
	/** The text of each open Task Record. */
	openTexts: readonly string[];
	/** The repository's Active days, sorted. */
	activeDays: readonly string[];
	/** How many Active days after its close day a closed record stays. */
	days: number;
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Whether `text` names the Task `id` as a whole word: a Task id is letters, digits, `_` and `-`. */
export const namesTask = (text: string, id: string): boolean => new RegExp(`(?<![\\w-])${escapeRegExp(id)}(?![\\w-])`).test(text);

/** Why the record stays in the repository, or `undefined` when it is outside the window. */
export function stayReason(record: TaskRecord, facts: WindowFacts): StayReason | undefined {
	const { header } = record;
	if (header.status === 'open') return 'open';
	if (!header.reconciled) return 'not reconciled';
	if (header.plan && facts.planOpen(header.plan)) return 'plan open';
	if (facts.openTexts.some((text) => namesTask(text, record.id))) return 'named by an open Task';
	const closed = header.closed ?? header.started;
	if (facts.activeDays.filter((day) => day > closed).length < facts.days) return 'recent';
	return undefined;
}

/** Whether the Plan page at `path` is open. A page that is gone holds nothing open; a broken one keeps its records until it is fixed. */
function planIsOpen(root: string, path: string): boolean {
	const file = join(root, path);
	if (!existsSync(file)) return false;
	try {
		const plan = parsePlan(readFileSync(file, 'utf8'), path);
		return plan !== undefined && isOpenPlan(plan);
	} catch (error) {
		if (error instanceof KalfaError) return true;
		throw error;
	}
}

function windowFacts(root: string, records: readonly TaskRecord[], days: number): WindowFacts {
	return {
		planOpen: (path) => planIsOpen(root, path),
		openTexts: records.filter((r) => r.header.status === 'open').map((r) => readFileSync(r.path, 'utf8')),
		activeDays: activeDays(root),
		days,
	};
}

const checkpointFiles = (dir: string) => (existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith('.md')).sort() : []);

/**
 * Moves each Task Record outside the window, with its Checkpoints, to the
 * archive in the Memory home in one commit, then removes them from the
 * repository's state. Returns the ids of the records that left. When the
 * commit fails it throws, and the repository keeps every file.
 */
export function archiveOutsideWindow(project: Project, home: string, days: number): string[] {
	const records = listRecords(project.root);
	const facts = windowFacts(project.root, records, days);
	const leaving = records.filter((record) => stayReason(record, facts) === undefined);
	if (!leaving.length) return [];
	const tasks = projectTasksDir(home, project);
	const checkpoints = projectCheckpointsDir(home, project);
	const write = leaving.flatMap((record) => {
		const dir = checkpointsDir(project.root, record.id);
		return [
			{ path: join(tasks, `${record.id}.md`), text: readFileSync(record.path, 'utf8') },
			...checkpointFiles(dir).map((name) => ({ path: join(checkpoints, record.id, name), text: readFileSync(join(dir, name), 'utf8') })),
		];
	});
	const ids = leaving.map((record) => record.id);
	commitHome(home, { write }, `archive ${ids.length} Task Record${ids.length === 1 ? '' : 's'} (${projectKey(project.root)}): ${ids.join(', ')}`);
	for (const record of leaving) {
		rmSync(record.path, { force: true });
		rmSync(checkpointsDir(project.root, record.id), { recursive: true, force: true });
	}
	return ids;
}
