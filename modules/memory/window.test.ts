import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { checkpointsDir } from '../../src/core/checkpoint.ts';
import { loadSettings } from '../../src/core/settings.ts';
import { recordPath, type TaskHeader, type TaskRecord } from '../../src/core/task-record.ts';
import { archived, DAYS, header, homeLog, KEY, setup } from '../../test/short-term-fixtures.ts';
import { memoryModule, sourceScope } from './handlers.ts';
import { tierOf } from './ranking.ts';
import { openIndex } from './search.ts';
import { memorySettings } from './settings.ts';
import { archiveOutsideWindow, namesTask, stayReason, type WindowFacts } from './window.ts';

// A zone east of UTC, as in the Active days tests: the days are local ones.
process.env.TZ = 'Europe/Skopje';

const record = (id: string, fields: Partial<TaskHeader> = {}): TaskRecord => ({ id, path: `/nowhere/${id}.md`, header: header(fields), sections: [] });

const facts = (more: Partial<WindowFacts> = {}): WindowFacts => ({ planOpen: () => false, openTexts: [], activeDays: DAYS, days: 5, ...more });

test('an open record, or a closed one the Cleanup has not reconciled, stays whatever its age', () => {
	assert.equal(stayReason(record('feat-a', { status: 'open', closed: undefined, reconciled: undefined }), facts()), 'open');
	assert.equal(stayReason(record('feat-a', { reconciled: undefined }), facts()), 'not reconciled');
	assert.equal(stayReason(record('feat-a'), facts()), undefined, 'reconciled and five Active days after its close: it leaves');
});

test('a reconciled record stays while fewer than N Active days follow its close day; the close day does not count', () => {
	assert.equal(stayReason(record('feat-a', { closed: '2026-03-02' }), facts()), 'recent', 'four Active days after 2026-03-02');
	assert.equal(stayReason(record('feat-a', { closed: '2026-03-02' }), facts({ days: 4 })), undefined, 'N is the setting');
	assert.equal(stayReason(record('feat-a', { closed: '2026-03-01' }), facts({ activeDays: ['2026-02-27', '2026-03-01', '2026-03-09'] })), 'recent', 'idle days do not count');
	assert.equal(stayReason(record('feat-a', { closed: undefined, started: '2026-03-02' }), facts()), 'recent', 'a record with no close day counts from its start');
});

test('a reconciled record stays while its Plan is open or an open Task Record names it', () => {
	const seen: string[] = [];
	const planOpen = (path: string) => (seen.push(path), path === 'docs/plan-open.md');
	assert.equal(stayReason(record('feat-a', { plan: 'docs/plan-open.md' }), facts({ planOpen })), 'plan open');
	assert.equal(stayReason(record('feat-a', { plan: 'docs/plan-done.md' }), facts({ planOpen })), undefined);
	assert.deepEqual(seen, ['docs/plan-open.md', 'docs/plan-done.md']);
	assert.equal(stayReason(record('feat-a'), facts({ openTexts: ['**Next:** read Task feat-a first.'] })), 'named by an open Task');
	assert.equal(stayReason(record('feat-a'), facts({ openTexts: ['feat-a-two and feat-ab and xfeat-a and feat_a'] })), undefined, 'only the whole id names it');
});

test('a Task id is named only as a whole word', () => {
	assert.ok(namesTask('(feat-a)', 'feat-a'));
	assert.ok(namesTask('feat-a.', 'feat-a'));
	assert.ok(namesTask('feat-a', 'feat-a'));
	assert.ok(!namesTask('feat-ab', 'feat-a'));
	assert.ok(!namesTask('my-feat-a', 'feat-a'));
	assert.ok(!namesTask('feat-a_b', 'feat-a'));
	assert.ok(!namesTask('featxa', 'feat.a'), 'the id is matched as text, not as a pattern');
});

test('the records outside the window move with their Checkpoints to the archive in one commit; the others stay', () => {
	const { root, home, project, write, checkpoint } = setup();
	write('feat-old');
	checkpoint('feat-old', '2026-03-01T10:00:00.000Z');
	checkpoint('feat-old', '2026-03-01T11:00:00.000Z');
	write('feat-recent', { closed: '2026-03-02' });
	write('feat-unreconciled', { reconciled: undefined });
	write('feat-planned', { plan: 'docs/plan-open.md' });
	write('feat-plan-done', { plan: 'docs/plan-done.md' });
	write('feat-plan-gone', { plan: 'docs/plan-gone.md' });
	write('feat-plan-broken', { plan: 'docs/plan-broken.md' });
	write('feat-named');
	write('feat-now', { status: 'open', closed: undefined, reconciled: undefined }, 'Read feat-named first.');
	const before = readFileSync(recordPath(root, 'feat-old'), 'utf8');
	const checkpoints = readdirSync(checkpointsDir(root, 'feat-old'));
	const texts = checkpoints.map((name) => readFileSync(join(checkpointsDir(root, 'feat-old'), name), 'utf8'));

	assert.deepEqual(archiveOutsideWindow(project, home, 5), ['feat-old', 'feat-plan-done', 'feat-plan-gone']);
	assert.equal(readFileSync(archived(home, 'tasks', 'feat-old.md'), 'utf8'), before);
	assert.deepEqual(readdirSync(archived(home, 'checkpoints', 'feat-old')), checkpoints);
	assert.deepEqual(
		checkpoints.map((name) => readFileSync(archived(home, 'checkpoints', 'feat-old', name), 'utf8')),
		texts,
	);
	assert.deepEqual(homeLog(home), [`archive 3 Task Records (${KEY}): feat-old, feat-plan-done, feat-plan-gone`]);
	for (const id of ['feat-old', 'feat-plan-done', 'feat-plan-gone']) assert.ok(!existsSync(recordPath(root, id)), `${id} left the repository`);
	assert.ok(!existsSync(checkpointsDir(root, 'feat-old')), 'its Checkpoints left with it');
	for (const id of ['feat-recent', 'feat-unreconciled', 'feat-planned', 'feat-plan-broken', 'feat-named', 'feat-now']) assert.ok(existsSync(recordPath(root, id)), `${id} stays`);
	assert.deepEqual(archiveOutsideWindow(project, home, 5), [], 'a second run finds nothing to move');
	assert.equal(homeLog(home).length, 1);
});

test('the commit days count as Active days too', () => {
	const { root, home, project, write } = setup();
	writeFileSync(join(root, '.kalfa/active-days'), '2026-03-03\n2026-03-04\n2026-03-05\n2026-03-06\n');
	write('feat-old', { closed: '2026-02-28' });
	assert.deepEqual(archiveOutsideWindow(project, home, 5), ['feat-old'], 'the commit on 2026-03-01 is the fifth Active day');
});

const closeEvent = (root: string, task: string) => ({ name: 'task.close' as const, harness: 'fake', cwd: root, task, record: recordPath(root, task) });

test('task close moves the records outside the window by the window-days setting and names them in its notice', () => {
	const { root, env, home, project, write } = setup('settings:\n  memory:\n    window-days: 4\n');
	write('feat-four', { closed: '2026-03-02' });
	write('feat-now', { reconciled: undefined });
	const result = memoryModule.handlers['task.close'](closeEvent(root, 'feat-now'), { project, settings: loadSettings(env), env, capabilities: new Set() });
	assert.match(result?.notice ?? '', /1 closed Task Record left the Short-term window for the archive in the Memory home: feat-four$/m);
	assert.ok(!existsSync(recordPath(root, 'feat-four')));
	assert.ok(existsSync(recordPath(root, 'feat-now')), 'the Task just closed waits for its Cleanup');
	assert.match(result?.context ?? '', /Cleanup of Task feat-now/);
	assert.equal(homeLog(home)[0], `archive 1 Task Record (${KEY}): feat-four`);
});

test('a failed move keeps every file in the repository, and the close still gives its Cleanup', () => {
	const { root, env, home, project, write, checkpoint } = setup();
	write('feat-old');
	checkpoint('feat-old', '2026-03-01T10:00:00.000Z');
	write('feat-now', { reconciled: undefined });
	mkdirSync(archived(home), { recursive: true });
	writeFileSync(archived(home, 'checkpoints'), 'a file where the folder goes');
	const result = memoryModule.handlers['task.close'](closeEvent(root, 'feat-now'), { project, settings: loadSettings(env), env, capabilities: new Set() });
	assert.match(result?.notice ?? '', /the move to the archive failed, so the closed Task Records stay in \.kalfa: /);
	assert.ok(existsSync(recordPath(root, 'feat-old')));
	assert.equal(readdirSync(checkpointsDir(root, 'feat-old')).length, 1);
	assert.match(result?.context ?? '', /Cleanup of Task feat-now/);
});

test('search ranks a Task Record in the repository as Short-term and its copy in the archive with the archive', () => {
	const { env, home, project, write } = setup();
	write('feat-old');
	const settings = memorySettings.parse({});
	const hitOf = () => openIndex(sourceScope(project, settings, env)).search('zeppelin feat-old', 5).find((hit) => hit.task === 'feat-old');
	assert.equal(tierOf(hitOf()!), 'short-term');
	assert.deepEqual(archiveOutsideWindow(project, home, 5), ['feat-old']);
	const hit = hitOf();
	assert.ok(hit?.ref.startsWith(archived(home, 'tasks')), hit?.ref);
	assert.equal(tierOf(hit!), 'archive');
});
