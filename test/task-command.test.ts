import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { sectionCommand, taskCommand } from '../src/cli/commands/task.ts';
import { main } from '../src/cli/main.ts';
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

test('start, close Sections, close: the whole Task in one record', async () => {
	const root = repo();
	let io = captureIo(root, inHarness);
	assert.equal(await task.run(['start', 'Build', 'the', 'monitoring', '--plan', 'docs/plan.md'], io), 0);
	const path = join(root, '.kalfa', 'tasks', 'feat-monitoring.md');
	assert.deepEqual(io.stdout, [`Task feat-monitoring started: ${path}`]);

	io = captureIo(root, inHarness, '**Done:** proved.\n\n**docs.pages:** runbook\n\n**Next:** render.\n');
	assert.equal(await section.run(['close', 'platforms proven'], io), 0);
	assert.deepEqual(io.stdout, [`Section "platforms proven" recorded in ${path}`, 'Task list: mark the item for "platforms proven" completed.', 'docs saw it']);

	io = captureIo(root, inHarness, '**Done:** all done.\n');
	assert.equal(await task.run(['close'], io), 0);
	assert.deepEqual(io.stdout, [`Task feat-monitoring closed: ${path}`, 'docs closes']);
	const text = readFileSync(path, 'utf8');
	assert.match(text, /status: closed\n/);
	assert.match(text, /## Section: platforms proven\n\n\*\*Done:\*\* proved\.\n\n\*\*docs\.pages:\*\* runbook/);
	assert.match(text, /## Close\n\n\*\*Done:\*\* all done\.\n$/);

	await assert.rejects(section.run(['close', 'late'], captureIo(root, inHarness, '**Done:** x\n')), /Task 'feat-monitoring' is closed/);
});

test('without a task list the Section is not mapped', async () => {
	const root = repo();
	await task.run(['start', 'goal'], captureIo(root));
	const io = captureIo(root, { HOME: tempDir() }, '**Done:** x\n');
	await section.run(['close', 's'], io);
	assert.deepEqual(io.stdout.slice(1), ['docs saw it']);
});

test('kalfa refuses to start a Task where git would commit the record', async () => {
	const root = repo('schema: 1\n', '');
	await assert.rejects(task.run(['start', 'goal'], captureIo(root)), /git does not ignore it/);
	assert.equal(existsSync(join(root, '.kalfa')), false);
});

test('a second start on the same branch is refused, --task names another', async () => {
	const root = repo();
	await task.run(['start', 'one'], captureIo(root));
	await assert.rejects(task.run(['start', 'two'], captureIo(root)), /already exists \(open\)/);
	assert.equal(await task.run(['start', 'two', '--task', 'side/quest'], captureIo(root)), 0);
	const io = captureIo(root);
	await task.run(['list'], io);
	assert.deepEqual(io.stdout, ['feat-monitoring  open  0 Section(s)  one', 'side-quest  open  0 Section(s)  two']);
});

test('--plan must name a Plan page from the repository root', async () => {
	const root = repo();
	await assert.rejects(task.run(['start', 'goal', '--plan', 'plan.md'], captureIo(root)), /--plan: no file 'plan\.md'/);
	await assert.rejects(task.run(['start', 'goal', '--plan', 'docs/log.md'], captureIo(root)), /is not a Plan/);
	assert.equal(existsSync(join(root, '.kalfa')), false);
});

test('a Section for a Module that is off is refused through main, with exit 1', async () => {
	const root = repo('schema: 1\n');
	await task.run(['start', 'goal'], captureIo(root));
	const io = captureIo(root, { HOME: tempDir() }, '**Done:** x\n**docs.pages:** y\n');
	assert.equal(await main(['section', 'close', 's'], io), 1);
	assert.match(io.stderr.join('\n'), /Module docs is not enabled/);
});

test('the session report lists open Tasks, and after /clear gives the Handoff', async () => {
	const root = repo();
	await task.run(['start', 'Build the monitoring'], captureIo(root));
	await section.run(['close', 'proven'], captureIo(root, { HOME: tempDir() }, '**Done:** x\n**Next:** render it.\n'));
	const context = { project: { root, file: undefined }, settings: { schema: 1 as const, modules: [] }, env: {}, capabilities: new Set<never>() };
	const base = { harness: 'fake', cwd: root, name: 'session.start' as const };
	const startup = await coreModule.handlers['session.start']!({ ...base, source: 'startup' }, context);
	assert.match(startup?.context ?? '', /- feat-monitoring: Build the monitoring \(1 Section\(s\)\)\n  Next: render it\./);
	const clear = await coreModule.handlers['session.start']!({ ...base, source: 'clear' }, context);
	assert.match(clear?.context ?? '', /^Continue the Task[\s\S]*Next: render it\.$/);
});

test('the session report puts the open Plans before the Tasks, and a broken glob is a notice', async () => {
	const root = repo("schema: 1\nplans: ['docs/**/*.md', 'nowhere/*.md']\n");
	await task.run(['start', 'Build the monitoring', '--plan', 'docs/plan.md'], captureIo(root));
	const context = { project: { root, file: { schema: 1 as const, modules: [], plans: ['docs/**/*.md', 'nowhere/*.md'], settings: {} } }, settings: { schema: 1 as const, modules: [] }, env: {}, capabilities: new Set<never>() };
	const result = await coreModule.handlers['session.start']!({ harness: 'fake', cwd: root, name: 'session.start', source: 'startup' }, context);
	assert.match(
		result?.context ?? '',
		/^Open Plans in this repository \(kalfa plan list\):\n- Monitoring \(active, 1 of 2 steps done; docs\/plan\.md\)\n  Next: Render\n\nOpen Tasks/,
	);
	assert.equal(result?.notice, "kalfa: Plans: plans glob 'nowhere/*.md' matches no file");
});

test('a repository without Plans or Tasks gets no session report', async () => {
	const root = repo();
	const context = { project: { root, file: { schema: 1 as const, modules: [], plans: [], settings: {} } }, settings: { schema: 1 as const, modules: [] }, env: {}, capabilities: new Set<never>() };
	assert.equal(await coreModule.handlers['session.start']!({ harness: 'fake', cwd: root, name: 'session.start', source: 'startup' }, context), undefined);
});
