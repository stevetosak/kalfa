import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { checkpointsDir } from '../../src/core/checkpoint.ts';
import { readRecord, recordPath } from '../../src/core/task-record.ts';
import { captureIo } from '../../test/helpers.ts';
import { archived, homeLog, KEY, setup } from '../../test/short-term-fixtures.ts';
import { memoryCommand } from './command.ts';
import { migrate, migrationPlan } from './migrate.ts';

// A zone east of UTC, as in the Active days tests: the days are local ones.
process.env.TZ = 'Europe/Skopje';

const MIGRATION_DAY = new Date('2026-03-10T12:00:00');

/**
 * Closed records from before the Cleanup (no mark): one outside the window
 * once marked, one recent, one whose Plan is open; a reconciled one outside
 * the window; an open Task.
 */
function repository(settings = '') {
	const world = setup(settings);
	world.write('feat-old', { reconciled: undefined });
	world.checkpoint('feat-old', '2026-03-01T10:00:00.000Z');
	world.write('feat-recent', { reconciled: undefined, closed: '2026-03-02' });
	world.write('feat-planned', { reconciled: undefined, plan: 'docs/plan-open.md' });
	world.write('feat-done');
	world.write('feat-now', { status: 'open', closed: undefined, reconciled: undefined });
	return world;
}

/** Every file of the repository's state, with its text. */
function stateFiles(root: string): Map<string, string> {
	const files = new Map<string, string>();
	const walk = (dir: string) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const path = join(dir, entry.name);
			if (entry.isDirectory()) walk(path);
			else files.set(path, readFileSync(path, 'utf8'));
		}
	};
	walk(join(root, '.kalfa'));
	return files;
}

const markOf = (root: string, id: string) => readRecord(root, id)?.header.reconciled;

test('the dry run names the records the Migration would mark and move, and writes nothing', () => {
	const { root, home, project } = repository();
	const before = stateFiles(root);
	assert.deepEqual(migrationPlan(project, 5, MIGRATION_DAY), { marked: ['feat-old', 'feat-planned', 'feat-recent'], moved: ['feat-done', 'feat-old'] });
	assert.deepEqual(stateFiles(root), before);
	assert.ok(!existsSync(home), 'no Memory home commit');
});

test('the Migration marks each closed record that has no mark reconciled, then moves the records outside the window with their Checkpoints', () => {
	const { root, home, project } = repository();
	const result = migrate(project, home, 5, MIGRATION_DAY);
	assert.deepEqual(result, { marked: ['feat-old', 'feat-planned', 'feat-recent'], moved: ['feat-done', 'feat-old'] });
	assert.equal(markOf(root, 'feat-recent'), '2026-03-10');
	assert.equal(markOf(root, 'feat-planned'), '2026-03-10');
	assert.equal(readRecord(root, 'feat-now')?.header.status, 'open');
	assert.equal(markOf(root, 'feat-now'), undefined, 'an open record is never marked');
	for (const id of ['feat-old', 'feat-done']) assert.ok(!existsSync(recordPath(root, id)), `${id} left the repository`);
	assert.ok(!existsSync(checkpointsDir(root, 'feat-old')));
	assert.match(readFileSync(archived(home, 'tasks', 'feat-old.md'), 'utf8'), /\nreconciled: 2026-03-10\n/, 'the archive holds the marked record');
	assert.equal(readFileSync(archived(home, 'tasks', 'feat-done.md'), 'utf8').match(/\nreconciled: (.*)\n/)?.[1], '2026-03-01', 'a mark already there stays');
	assert.equal(readdirSync(archived(home, 'checkpoints', 'feat-old')).length, 1);
	assert.deepEqual(homeLog(home), [`archive 2 Task Records (${KEY}): feat-done, feat-old`]);

	assert.deepEqual(migrate(project, home, 5, new Date('2026-03-11T12:00:00')), { marked: [], moved: [] }, 'a second run finds nothing');
	assert.equal(markOf(root, 'feat-recent'), '2026-03-10', 'a second run does not mark again');
	assert.equal(homeLog(home).length, 1);
});

test('a failed move keeps the marks and every file, and returns the failure', () => {
	const { root, home, project } = repository();
	mkdirSync(archived(home), { recursive: true });
	writeFileSync(archived(home, 'checkpoints'), 'a file where the folder goes');
	const result = migrate(project, home, 5, MIGRATION_DAY);
	assert.deepEqual(result.marked, ['feat-old', 'feat-planned', 'feat-recent']);
	assert.deepEqual(result.moved, []);
	assert.ok(result.failure, 'the failure is returned');
	assert.equal(markOf(root, 'feat-old'), '2026-03-10', 'the mark stays');
	assert.equal(markOf(root, 'feat-done'), '2026-03-01');
	assert.equal(readdirSync(checkpointsDir(root, 'feat-old')).length, 1);
});

const run = async (root: string, env: NodeJS.ProcessEnv, ...args: string[]) => {
	const io = captureIo(root, env);
	const code = await memoryCommand().run(['migrate', ...args], io);
	return { code, out: io.stdout.join('\n') };
};

test('kalfa memory migrate: the dry run and the run report the records, by the window-days setting', async () => {
	const { root, env, home } = repository('settings:\n  memory:\n    window-days: 4\n');
	const before = stateFiles(root);
	const dry = await run(root, env, '--dry-run');
	assert.equal(dry.code, 0);
	assert.equal(
		dry.out,
		'Would mark 3 closed Task Records reconciled: feat-old, feat-planned, feat-recent\nWould move 3 Task Records with their Checkpoints to the archive in the Memory home: feat-done, feat-old, feat-recent',
	);
	assert.deepEqual(stateFiles(root), before, 'the dry run writes nothing');
	assert.ok(!existsSync(home));

	const done = await run(root, env);
	assert.equal(done.code, 0);
	assert.equal(done.out, 'Marked 3 closed Task Records reconciled: feat-old, feat-planned, feat-recent\nMoved 3 Task Records with their Checkpoints to the archive in the Memory home: feat-done, feat-old, feat-recent');
	assert.deepEqual(await run(root, env), { code: 0, out: 'No closed Task Record waits for its mark.\nNo Task Record is outside the Short-term window.' });
});

test('kalfa memory migrate exits 1 when the move fails, and names the failure', async () => {
	const { root, env, home } = repository();
	mkdirSync(archived(home), { recursive: true });
	writeFileSync(archived(home, 'checkpoints'), 'a file where the folder goes');
	const failed = await run(root, env);
	assert.equal(failed.code, 1);
	assert.match(failed.out, /^Marked 3 closed Task Records reconciled: feat-old, feat-planned, feat-recent\nThe move to the archive failed, so the records stay in \.kalfa; the next Task close moves them: /);
});
