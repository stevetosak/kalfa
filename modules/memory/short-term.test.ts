import assert from 'node:assert/strict';
import { utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadSettings } from '../../src/core/settings.ts';
import { recordPath, type TaskHeader, type TaskRecord, writeRecord } from '../../src/core/task-record.ts';
import { tempDir } from '../../test/helpers.ts';
import { DAYS, header, setup } from '../../test/short-term-fixtures.ts';
import { memoryModule } from './handlers.ts';
import { idleTasks, lastWriteDay, missedCleanups, shortTermReport } from './short-term.ts';

// A zone east of UTC, as in the Active days tests: the days are local ones.
process.env.TZ = 'Europe/Skopje';

const record = (id: string, fields: Partial<TaskHeader> = {}): TaskRecord => ({ id, path: `/nowhere/${id}.md`, header: header(fields), sections: [] });
const open = (id: string) => record(id, { status: 'open', closed: undefined, reconciled: undefined });

test('a missed Cleanup is a closed record with no reconciled mark; the oldest close comes first', () => {
	const records = [
		record('feat-b', { reconciled: undefined, closed: '2026-03-02' }),
		record('feat-done'),
		open('feat-open'),
		record('feat-c', { reconciled: undefined, closed: '2026-03-01' }),
		record('feat-a', { reconciled: undefined, closed: '2026-03-02' }),
	];
	assert.deepEqual(missedCleanups(records).map((r) => r.id), ['feat-c', 'feat-a', 'feat-b']);
});

test('an open Task is idle after N Active days with no write; its last write day and idle days do not count', () => {
	const lastWrite = (r: TaskRecord) => ({ 'feat-a': '2026-03-01', 'feat-b': '2026-03-02', 'feat-done': '2026-03-01' })[r.id] ?? '';
	const records = [open('feat-b'), open('feat-a'), record('feat-done')];
	assert.deepEqual(idleTasks(records, { activeDays: DAYS, days: 4, lastWrite }), [
		{ id: 'feat-a', since: '2026-03-01', days: 5 },
		{ id: 'feat-b', since: '2026-03-02', days: 4 },
	]);
	assert.deepEqual(idleTasks(records, { activeDays: DAYS, days: 5, lastWrite }).map((t) => t.id), ['feat-a'], 'N is inclusive');
	assert.deepEqual(idleTasks(records, { activeDays: ['2026-02-20', '2026-03-01', '2026-03-09'], days: 2, lastWrite }), [], 'calendar days with no activity do not count');
});

test('the last write day is the local day of the record file', () => {
	const path = join(tempDir(), 'feat-a.md');
	writeFileSync(path, 'x');
	utimesSync(path, new Date('2026-03-01T23:30:00Z'), new Date('2026-03-01T23:30:00Z'));
	assert.equal(lastWriteDay({ ...record('feat-a'), path }), '2026-03-02', 'in Skopje 23:30 UTC is the next day');
});

test('the report names at most three ids, then how many more, and says nothing when nothing waits', () => {
	const missed = ['feat-a', 'feat-b', 'feat-c', 'feat-d'].map((id) => record(id, { reconciled: undefined }));
	const idle = [{ id: 'feat-x', since: '2026-03-01', days: 1 }];
	const report = shortTermReport(missed, idle, 1);
	assert.equal(
		report.context,
		'Closed Task Records that missed their Cleanup (not reconciled): feat-a, feat-b, feat-c and 1 more. The next Task close takes in their findings with its own Cleanup.\n' +
			'Open Tasks with no write to their record for 1 or more Active days: feat-x (last write 2026-03-01, 1 Active day since). Tell the Operator; the Operator decides whether to close each one or go on with it.',
	);
	assert.equal(report.summary, '4 missed Cleanups · 1 idle Task: feat-x');
	assert.deepEqual(shortTermReport([], [], 7), { context: undefined, summary: undefined });
});

const startEvent = (root: string) => ({ name: 'session.start' as const, harness: 'fake', cwd: root, source: 'startup' as const });

/** A record last written at noon on `day`, local time. */
function writtenOn(root: string, id: string, day: string): void {
	const at = new Date(`${day}T12:00:00`);
	utimesSync(recordPath(root, id), at, at);
}

test('session start names the missed Cleanups and the open Tasks idle for idle-task-days Active days', () => {
	const { root, env, project, write } = setup('settings:\n  memory:\n    idle-task-days: 5\n');
	write('feat-missed', { reconciled: undefined });
	write('feat-idle', { status: 'open', closed: undefined, reconciled: undefined });
	writtenOn(root, 'feat-idle', '2026-03-01');
	write('feat-busy', { status: 'open', closed: undefined, reconciled: undefined });
	writtenOn(root, 'feat-busy', '2026-03-02');
	const result = memoryModule.handlers['session.start'](startEvent(root), { project, settings: loadSettings(env), env, capabilities: new Set() });
	assert.match(result?.context ?? '', /^Closed Task Records that missed their Cleanup \(not reconciled\): feat-missed\. /m);
	assert.match(result?.context ?? '', /^Open Tasks with no write to their record for 5 or more Active days: feat-idle \(last write 2026-03-01, 5 Active days since\)\. /m);
	assert.match(result?.notice ?? '', /1 missed Cleanup · 1 idle Task: feat-idle/);
});

test('session start says nothing of Short-term memory when no Cleanup was missed and no Task is idle by the default seven days', () => {
	const { root, env, project, write } = setup();
	write('feat-done');
	write('feat-idle', { status: 'open', closed: undefined, reconciled: undefined });
	writtenOn(root, 'feat-idle', '2026-03-01');
	const result = memoryModule.handlers['session.start'](startEvent(root), { project, settings: loadSettings(env), env, capabilities: new Set() });
	assert.doesNotMatch(`${result?.context}\n${result?.notice}`, /missed|idle|Open Tasks with no write/);
});

const closeEvent = (root: string, task: string) => ({ name: 'task.close' as const, harness: 'fake', cwd: root, task, record: recordPath(root, task) });

function remembering(root: string, id: string, fields: Partial<TaskHeader>, remember: string): void {
	writeRecord(root, { id, header: header(fields), sections: [{ title: `Work on ${id}`, parts: new Map([['Done', 'Work.'], ['Remember', remember], ['Next', 'Nothing.']]) }] });
}

test('task close takes in the missed Cleanups, the oldest first and a few at a time, each with its findings and its reconciled command', () => {
	const { root, env, project } = setup();
	remembering(root, 'feat-now', { reconciled: undefined, closed: '2026-03-06' }, '- the finding of now');
	remembering(root, 'feat-m1', { reconciled: undefined, closed: '2026-03-01' }, '- the finding of m1');
	remembering(root, 'feat-m2', { reconciled: undefined, closed: '2026-03-02' }, 'none');
	remembering(root, 'feat-m3', { reconciled: undefined, closed: '2026-03-03' }, '- the finding of m3');
	remembering(root, 'feat-m4', { reconciled: undefined, closed: '2026-03-04' }, '- the finding of m4');
	remembering(root, 'feat-done', { closed: '2026-03-05' }, '- the finding of done');
	const result = memoryModule.handlers['task.close'](closeEvent(root, 'feat-now'), { project, settings: loadSettings(env), env, capabilities: new Set() });
	const steps = (result?.context ?? '').split('\n');
	const block = steps.indexOf('Closed Task Records that missed their Cleanup: take their findings in too, then mark each one.');
	assert.ok(block > 0, steps.join('\n'));
	assert.deepEqual(steps.slice(block + 1, block + 10), [
		'- Task feat-m1 (closed 2026-03-01): its findings:',
		'  - Work on feat-m1: the finding of m1',
		'  Then: `kalfa task reconciled --task feat-m1`.',
		'- Task feat-m2 (closed 2026-03-02): no finding in a Remember part.',
		'  Then: `kalfa task reconciled --task feat-m2`.',
		'- Task feat-m3 (closed 2026-03-03): its findings:',
		'  - Work on feat-m3: the finding of m3',
		'  Then: `kalfa task reconciled --task feat-m3`.',
		'- 1 more wait for the next Task close.',
	]);
	assert.ok(steps.includes('- Work on feat-now: the finding of now'), 'the closing Task keeps its own findings');
	assert.ok(!steps.some((l) => l.includes('feat-done')), 'a reconciled record is not taken in');
	assert.ok(steps.some((l) => l.includes(`--source "Task <the finding's Task> (`)), 'each finding names its own Task as the source');
	assert.equal(steps.at(-1), 'Then mark the record: `kalfa task reconciled --task feat-now`.');
	assert.match(result?.notice ?? '', /^kalfa: memory: the Cleanup takes in 3 missed Cleanups: feat-m1, feat-m2, feat-m3$/m);
});

test('task close with no missed Cleanup keeps the Cleanup as it was', () => {
	const { root, env, project } = setup();
	remembering(root, 'feat-now', { reconciled: undefined }, '- the finding of now');
	const result = memoryModule.handlers['task.close'](closeEvent(root, 'feat-now'), { project, settings: loadSettings(env), env, capabilities: new Set() });
	assert.ok(!(result?.context ?? '').includes('missed'));
	assert.ok((result?.context ?? '').includes('--source "Task feat-now ('));
	assert.doesNotMatch(result?.notice ?? '', /missed/);
});
