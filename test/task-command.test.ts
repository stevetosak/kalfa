import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { sectionCommand, taskCommand } from '../src/cli/commands/task.ts';
import { main } from '../src/cli/main.ts';
import { isContinueWord } from '../src/core/continue-word.ts';
import { CHECKPOINTS_KEPT, checkpointsDir, lastCheckpoint, writeCheckpoint } from '../src/core/checkpoint.ts';
import { COMPACT_FOCUS_MAX, compactFocus, writeRecord } from '../src/core/task-record.ts';
import { wakePath } from '../src/core/wake.ts';
import { coreModule } from '../src/modules/core.ts';
import { fakeAdapter, registry } from './fakes.ts';
import { captureIo, gitRepo, tempDir } from './helpers.ts';

const docs = { name: 'docs', handlers: { 'section.close': () => ({ context: 'docs saw it' }), 'task.close': () => ({ context: 'docs closes' }) } };
const modules = registry(coreModule, docs);
const adapters = new Map([['fake', fakeAdapter]]);
const task = taskCommand(adapters, modules);
const section = sectionCommand(adapters, modules);

const PLAN = '---\ntitle: Monitoring\ntype: plan\nstatus: active\n---\n\n- [x] **Prove** the platforms.\n- [ ] **Render** core/monitoring.\n';

function repo(kalfaYaml = 'schema: 1\nmodules: [docs]\n', ignore = '.kalfa/\n'): string {
	const root = gitRepo({ 'kalfa.yaml': kalfaYaml, '.gitignore': ignore, 'docs/plan.md': PLAN, 'docs/log.md': '---\ntype: log\n---\n' });
	execFileSync('git', ['-C', root, 'checkout', '-q', '-b', 'feat/monitoring']);
	return root;
}

const inHarness = { HOME: tempDir(), KALFA_FAKE_HARNESS: '1' };

/** A repository with Task feat-monitoring open on its branch, one Section closed. */
async function openTask() {
	const root = repo();
	await task.run(['start', '--done-when', 'it works', 'Build the monitoring'], captureIo(root));
	await section.run(['close', 'proven'], captureIo(root, { HOME: tempDir() }, '**Done:** x\n**Found:** the API answers.\n**Next:** render it.\n'));
	const context = { project: { root, file: undefined }, settings: { schema: 1 as const, modules: [] }, env: { HOME: tempDir() }, capabilities: new Set<never>() };
	const base = { harness: 'fake', cwd: root, name: 'session.start' as const };
	return { root, context, base };
}

test('start, close Sections, close: the whole Task in one record', async () => {
	const root = repo();
	let io = captureIo(root, inHarness);
	assert.equal(await task.run(['start', '--done-when', 'it works', 'Build', 'the', 'monitoring', '--plan', 'docs/plan.md'], io), 0);
	const path = join(root, '.kalfa', 'tasks', 'feat-monitoring.md');
	assert.deepEqual(io.stdout, [`Task feat-monitoring started: ${path}`]);

	io = captureIo(root, inHarness, '**Done:** proved.\n\n**docs.pages:** runbook\n\n**Next:** render.\n');
	assert.equal(await section.run(['close', 'platforms proven'], io), 0);
	assert.deepEqual(io.stdout, [`Section "platforms proven" recorded in ${path}`, 'Task list: mark the item for "platforms proven" completed.', 'docs saw it']);

	await assert.rejects(task.run(['close'], captureIo(root, inHarness, '**Done:** all done.\n')), /the Task has a finish line:\n {2}Done when: it works\nCheck it, ask the Operator/);
	await assert.rejects(task.run(['close'], captureIo(root, inHarness, '**Done when:** yes\n')), /starts with "holds — " or "not met — "/);
	assert.match(readFileSync(path, 'utf8'), /status: open\n/);
	io = captureIo(root, inHarness, '**Done:** all done.\n\n**Done when:** holds — the test reads it back.\n');
	assert.equal(await task.run(['close'], io), 0);
	assert.deepEqual(io.stdout, [`Task feat-monitoring closed: ${path}`, 'docs closes']);
	const text = readFileSync(path, 'utf8');
	assert.match(text, /done-when: it works\nstatus: closed\n/);
	assert.match(text, /## Section: platforms proven\n\n\*\*Done:\*\* proved\.\n\n\*\*docs\.pages:\*\* runbook/);
	assert.match(text, /## Close\n\n\*\*Done:\*\* all done\.\n\n\*\*Done when:\*\* holds — the test reads it back\.\n$/);

	await assert.rejects(section.run(['close', 'late'], captureIo(root, inHarness, '**Done:** x\n')), /Task 'feat-monitoring' is closed/);
});

test('without a task list the Section is not mapped', async () => {
	const root = repo();
	await task.run(['start', '--done-when', 'it works', 'goal'], captureIo(root));
	const io = captureIo(root, { HOME: tempDir() }, '**Done:** x\n');
	await section.run(['close', 's'], io);
	assert.deepEqual(io.stdout.slice(1), ['docs saw it']);
});

test('kalfa refuses to start a Task where git would commit the record', async () => {
	const root = repo('schema: 1\n', '');
	await assert.rejects(task.run(['start', '--done-when', 'it works', 'goal'], captureIo(root)), /git does not ignore it/);
	assert.equal(existsSync(join(root, '.kalfa')), false);
});

test('a new Task needs a finish line; an old record without one still reads and closes', async () => {
	const root = repo();
	await assert.rejects(task.run(['start', 'goal'], captureIo(root)), /give --done-when/);
	writeRecord(root, { id: 'feat-monitoring', header: { schema: 1, goal: 'old', status: 'open', started: '2026-10-01' }, sections: [] });
	assert.equal(await task.run(['close'], captureIo(root)), 0);
	assert.match(readFileSync(join(root, '.kalfa', 'tasks', 'feat-monitoring.md'), 'utf8'), /status: closed/);
});

test('a second start on the same branch is refused, --task names another', async () => {
	const root = repo();
	await task.run(['start', '--done-when', 'it works', 'one'], captureIo(root));
	await assert.rejects(task.run(['start', '--done-when', 'it works', 'two'], captureIo(root)), /already exists \(open\)/);
	assert.equal(await task.run(['start', '--done-when', 'it works', 'two', '--task', 'side/quest'], captureIo(root)), 0);
	const io = captureIo(root);
	await task.run(['list'], io);
	assert.deepEqual(io.stdout, ['feat-monitoring  open  0 Section(s)  one', 'side-quest  open  0 Section(s)  two']);
});

test('--plan must name a Plan page from the repository root', async () => {
	const root = repo();
	await assert.rejects(task.run(['start', '--done-when', 'it works', 'goal', '--plan', 'plan.md'], captureIo(root)), /--plan: no file 'plan\.md'/);
	await assert.rejects(task.run(['start', '--done-when', 'it works', 'goal', '--plan', 'docs/log.md'], captureIo(root)), /is not a Plan/);
	assert.equal(existsSync(join(root, '.kalfa')), false);
});

test('a Section for a Module that is off is refused through main, with exit 1', async () => {
	const root = repo('schema: 1\n');
	await task.run(['start', '--done-when', 'it works', 'goal'], captureIo(root));
	const io = captureIo(root, { HOME: tempDir() }, '**Done:** x\n**docs.pages:** y\n');
	assert.equal(await main(['section', 'close', 's'], io), 1);
	assert.match(io.stderr.join('\n'), /Module docs is not enabled/);
});

test('the session report lists open Tasks on startup', async () => {
	const { context, base } = await openTask();
	const startup = await coreModule.handlers['session.start']!({ ...base, source: 'startup' }, context);
	assert.match(startup?.context ?? '', /- feat-monitoring: Build the monitoring \(1 Section\(s\)\)\n  Done when: it works\n  Next: render it\./);
	assert.equal(startup?.notice, 'kalfa: Task feat-monitoring open on this branch (after /clear, "continue" loads its Handoff)');
});

test('after /clear the Operator sees the brief, and the agent gets a pointer, not the Handoff', async () => {
	const { context, base } = await openTask();
	const clear = await coreModule.handlers['session.start']!({ ...base, source: 'clear', sessionId: 's1' }, context);
	assert.equal(
		clear?.notice,
		[
			'kalfa: Task feat-monitoring: Build the monitoring',
			'  Done when: it works',
			'  Done: proven',
			'  State: proven: the API answers.',
			'  Next: render it.',
			'Type "continue" to load its Handoff, or give a new task.',
		].join('\n'),
	);
	assert.match(clear?.context ?? '', /^Task feat-monitoring is open on this branch; the Operator sees its brief\. If the first prompt is a continue word/);
	assert.doesNotMatch(clear?.context ?? '', /Next: render it/);
});

test('the first prompt after /clear: a continue word loads the Handoff once', async () => {
	const { root, context, base } = await openTask();
	await coreModule.handlers['session.start']!({ ...base, source: 'clear', sessionId: 's1' }, context);
	assert.equal(existsSync(wakePath(root, 'prompt.submit')), true);
	const prompt = (text: string) => coreModule.handlers['prompt.submit']!({ harness: 'fake', cwd: root, name: 'prompt.submit', prompt: text, sessionId: 's1' }, context);
	const first = await prompt(' Continue! ');
	assert.match(first?.context ?? '', /^The Operator continues Task feat-monitoring\. Continue the Task from its record[\s\S]*\nDone when: it works\n[\s\S]*Next: render it\.$/);
	assert.equal(first?.notice, 'kalfa: Handoff of Task feat-monitoring loaded');
	assert.equal(existsSync(wakePath(root, 'prompt.submit')), false);
	assert.equal(await prompt('continue'), undefined);
});

test('the first prompt after /clear: any other prompt is a new task and uses up the wake', async () => {
	const { root, context, base } = await openTask();
	await coreModule.handlers['session.start']!({ ...base, source: 'clear', sessionId: 's1' }, context);
	const prompt = (text: string, sessionId = 's1') => coreModule.handlers['prompt.submit']!({ harness: 'fake', cwd: root, name: 'prompt.submit', prompt: text, sessionId }, context);
	assert.equal(await prompt('fix the login page'), undefined);
	assert.equal(existsSync(wakePath(root, 'prompt.submit')), false);
	assert.equal(await prompt('continue'), undefined);

	await coreModule.handlers['session.start']!({ ...base, source: 'clear', sessionId: 's1' }, context);
	assert.equal(await prompt('continue', 'another session'), undefined, 'a wake from another session is dropped');
	assert.equal(existsSync(wakePath(root, 'prompt.submit')), false);
});

for (const source of ['compact', 'fork'] as const) {
	test(`after ${source} the Handoff loads at once, with no brief`, async () => {
		const { root, context, base } = await openTask();
		const result = await coreModule.handlers['session.start']!({ ...base, source }, context);
		assert.match(result?.context ?? '', /^Continue the Task[\s\S]*\nDone when: it works\n[\s\S]*Next: render it\.$/);
		assert.equal(result?.notice, 'kalfa: Handoff of Task feat-monitoring loaded again');
		assert.equal(existsSync(wakePath(root, 'prompt.submit')), false);
	});
}

test('the continue words', () => {
	for (const yes of ['continue', 'C', 'go  on.', ' Continue!\n']) assert.equal(isContinueWord(yes), true, yes);
	for (const no of ['continue with the login page', 'cont', 'go', '']) assert.equal(isContinueWord(no), false, no);
});

test('before a compaction the summary is told what the Task needs: goal, finish line, Decisions, Next', async () => {
	const { root, context } = await openTask();
	await section.run(['close', 'chose'], captureIo(root, { HOME: tempDir() }, '**Done:** y\n**Decisions:** Grafana, not Kibana.\n**Next:** wire the alerts.\n'));
	const event = { harness: 'fake', cwd: root, name: 'compact.before' as const, trigger: 'auto' };
	const focus = await coreModule.handlers['compact.before']!(event, context);
	assert.match(focus?.context ?? '', /^This session works on kalfa Task feat-monitoring \(record: .*feat-monitoring\.md\)\. Keep these in the summary/);
	assert.match(focus?.context ?? '', /\n- Goal: Build the monitoring\n- Done when: it works\n- Sections closed: proven; chose\n- Decisions:\n {2}chose:\n {4}Grafana, not Kibana\.\n- Next: wire the alerts\.\n/);
	assert.equal(await coreModule.handlers['compact.before']!({ ...event, subagent: true }, context), undefined, "a subagent's compaction is its own");
});

test('the compact focus keeps the newest Decisions when they do not all fit', () => {
	const big = 'x'.repeat(2500);
	const sections = ['one', 'two', 'three'].map((title) => ({ title, parts: new Map([['Done', 'd'], ['Decisions', `${title} ${big}`]]) }));
	const record = { id: 't', path: '/r/t.md', header: { schema: 1 as const, goal: 'g', status: 'open' as const, started: '2026-11-12' }, sections };
	const focus = compactFocus(record);
	assert.ok(focus.length <= COMPACT_FOCUS_MAX, `${focus.length} > ${COMPACT_FOCUS_MAX}`);
	assert.doesNotMatch(focus, / {2}one:/);
	assert.match(focus, / {2}two:[\s\S]* {2}three:/);
	assert.match(focus, /- Next: not recorded/);
});

test('after a compaction the summary is the Task\'s newest Checkpoint; only the newest few are kept', async () => {
	const { root, context } = await openTask();
	const after = (summary: string) => coreModule.handlers['compact.after']!({ harness: 'fake', cwd: root, name: 'compact.after', trigger: 'manual', summary, sessionId: 's1' }, context);
	const result = await after('## 1. Primary request\nBuild it.');
	assert.match(result?.notice ?? '', /^kalfa: checkpoint of Task feat-monitoring saved \(manual compaction\): .*\.kalfa\/checkpoints\/feat-monitoring\/\d{8}T\d{6}Z-manual\.md$/);
	const last = lastCheckpoint(root, 'feat-monitoring');
	assert.equal(last?.summary, '## 1. Primary request\nBuild it.');
	assert.equal(last?.trigger, 'manual');
	assert.equal(last?.session, 's1');
	assert.equal(await after('  '), undefined, 'an empty summary is not kept');

	const dir = checkpointsDir(root, 'feat-monitoring');
	for (let i = 0; i < CHECKPOINTS_KEPT + 2; i++) writeCheckpoint(root, { task: 'feat-monitoring', trigger: 'auto', at: `2030-01-01T00:00:0${i}.000Z`, summary: `n${i}` });
	assert.equal(readdirSync(dir).length, CHECKPOINTS_KEPT);
	assert.equal(lastCheckpoint(root, 'feat-monitoring')?.summary, `n${CHECKPOINTS_KEPT + 1}`);
});

test('a compaction on a branch without an open Task does nothing', async () => {
	const root = repo();
	const context = { project: { root, file: undefined }, settings: { schema: 1 as const, modules: [] }, env: { HOME: tempDir() }, capabilities: new Set<never>() };
	assert.equal(await coreModule.handlers['compact.before']!({ harness: 'fake', cwd: root, name: 'compact.before', trigger: 'auto' }, context), undefined);
	assert.equal(await coreModule.handlers['compact.after']!({ harness: 'fake', cwd: root, name: 'compact.after', trigger: 'auto', summary: 's' }, context), undefined);
	assert.equal(existsSync(join(root, '.kalfa/checkpoints')), false);
});

test('the session report puts the open Plans before the Tasks, and a broken glob is a notice', async () => {
	const root = repo("schema: 1\nplans: ['docs/**/*.md', 'nowhere/*.md']\n");
	await task.run(['start', '--done-when', 'it works', 'Build the monitoring', '--plan', 'docs/plan.md'], captureIo(root));
	const context = { project: { root, file: { schema: 1 as const, modules: [], plans: ['docs/**/*.md', 'nowhere/*.md'], settings: {} } }, settings: { schema: 1 as const, modules: [] }, env: { HOME: tempDir() }, capabilities: new Set<never>() };
	const result = await coreModule.handlers['session.start']!({ harness: 'fake', cwd: root, name: 'session.start', source: 'startup' }, context);
	assert.match(
		result?.context ?? '',
		/^Open Plans in this repository \(kalfa plan list\):\n- Monitoring \(active, 1 of 2 steps done; docs\/plan\.md\)\n  Next: Render\n\nOpen Tasks/,
	);
	assert.equal(result?.notice, `kalfa: 1 open Plan · Task feat-monitoring open on this branch (after /clear, "continue" loads its Handoff)\nkalfa: Plans: plans glob 'nowhere/*.md' matches no file`);
});

test('a repository without Plans or Tasks gets no session report', async () => {
	const root = repo();
	const context = { project: { root, file: { schema: 1 as const, modules: [], plans: [], settings: {} } }, settings: { schema: 1 as const, modules: [] }, env: { HOME: tempDir() }, capabilities: new Set<never>() };
	assert.equal(await coreModule.handlers['session.start']!({ harness: 'fake', cwd: root, name: 'session.start', source: 'startup' }, context), undefined);
});

test('section close hands the handlers the session the harness names, and --no-reset', async () => {
	const seen: unknown[] = [];
	const spy = { name: 'docs', handlers: { 'section.close': (event: unknown) => void seen.push(event) } };
	const withSession = new Map([['fake', { ...fakeAdapter, currentSession: (env: NodeJS.ProcessEnv) => env.FAKE_SESSION }]]);
	const close = sectionCommand(withSession, registry(coreModule, spy));
	const root = repo();
	await task.run(['start', '--done-when', 'it works', 'Build'], captureIo(root, inHarness));
	await close.run(['close', 'one', '--no-reset', '4'], captureIo(root, { ...inHarness, FAKE_SESSION: 's9' }, '**Done:** x\n'));
	assert.deepEqual(seen.map((e) => [(e as { sessionId?: string }).sessionId, (e as { noReset?: number }).noReset]), [['s9', 4]]);
	await assert.rejects(close.run(['close', 'two', '--no-reset', 'few'], captureIo(root, inHarness, '**Done:** x\n')), /--no-reset takes the requests/);
});
