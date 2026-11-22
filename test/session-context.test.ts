import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { claudeAdapter } from '../src/adapters/claude/adapter.ts';
import { hookCommand } from '../src/cli/commands/hook.ts';
import { installCommand, uninstallCommand } from '../src/cli/commands/install.ts';
import { taskCommand } from '../src/cli/commands/task.ts';
import { contextSizeLine, contextSizes, recordContextSize } from '../src/core/context-size.ts';
import { memoryHome, personalLayer, projectLayer } from '../src/core/memory/home.ts';
import { DEFAULT_SETTINGS } from '../src/core/settings.ts';
import { recordPath } from '../src/core/task-record.ts';
import { coreModule } from '../src/modules/core.ts';
import { fakeAdapter, registry } from './fakes.ts';
import { captureIo, gitRepo, legacyRecord, seedRecord, tempDir, tempRepo } from './helpers.ts';

const pkg = tempRepo({ 'package.json': '{}\n', 'dist/kalfa-hook': '', 'dist/adapters/claude/status-tap': '' });
const adapters = new Map([['claude', claudeAdapter]]);
const install = installCommand(adapters, () => [], () => pkg);
const uninstall = uninstallCommand(adapters, () => []);

function machine() {
	const home = tempRepo({ '.config/kalfa/config.yaml': 'schema: 1\nmodules: []\n' });
	const repo = gitRepo();
	execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', 'git@github.com:Someone/Project.git']);
	return { home, repo, env: { HOME: home } };
}

/** The instruction file an earlier kalfa wrote with the Personal layer's index; retired with ADR 0003. */
const file = (home: string) => join(home, '.claude/rules/kalfa-memory.md');
const statePath = (home: string) => join(home, '.config/kalfa/install.yaml');
/** The machine as an earlier `kalfa install` left it: the instruction file, recorded in install.yaml, next to one of the Operator's rule files. */
function earlierInstall(home: string) {
	mkdirSync(join(home, '.claude/rules'), { recursive: true });
	writeFileSync(file(home), '# Standing memory (kalfa)\n');
	writeFileSync(join(home, '.claude/rules/own.md'), 'The Operator\'s own rule.\n');
	const claude = { approvals: { allow: [], ask: [], deny: [] }, instructions: '.claude/rules/kalfa-memory.md' };
	writeFileSync(statePath(home), `${JSON.stringify({ schema: 1, harnesses: { claude }, steps: [] })}\n`);
}
/** A rule record of the old Standing memory: no write command makes one now. */
const personalRule = (env: NodeJS.ProcessEnv, summary: string) => legacyRecord(env, personalLayer(memoryHome(env)), 'stage-files-by-name', { type: 'rule', summary });
const projectRule = (env: NodeJS.ProcessEnv, repo: string) => legacyRecord(env, projectLayer(memoryHome(env), { root: repo, file: undefined }), 'a-project-rule', { type: 'rule', summary: 'A project rule.' });

const start = (repo: string, env: NodeJS.ProcessEnv, capabilities: string[], contextCap?: number) =>
	coreModule.handlers['session.start']!(
		{ name: 'session.start', source: 'startup', harness: 'claude', cwd: repo },
		{ project: { root: repo, file: undefined }, settings: DEFAULT_SETTINGS, env, capabilities: new Set(capabilities), contextCap } as never,
	);

test('install writes no instruction file; install removes the retired one that install.yaml records and keeps the Operator\'s files', async () => {
	const fresh = machine();
	seedRecord(fresh.env, personalLayer(memoryHome(fresh.env)), 'never-push-to-main', { type: 'fact', summary: 'Never push to main.' });
	await install.run([], captureIo(fresh.home, fresh.env));
	assert.ok(!existsSync(file(fresh.home)), 'install wrote an instruction file');
	assert.doesNotMatch(readFileSync(statePath(fresh.home), 'utf8'), /instructions/);

	const { home, env } = machine();
	earlierInstall(home);
	const io = captureIo(home, env);
	await install.run([], io);
	assert.match(io.stdout.join('\n'), /instructions: remove .*kalfa-memory\.md \(retired: the Personal layer loads in the session report\)/);
	assert.ok(!existsSync(file(home)), 'install left the retired file');
	assert.ok(existsSync(join(home, '.claude/rules/own.md')), "install removed the Operator's rule file");
	assert.doesNotMatch(readFileSync(statePath(home), 'utf8'), /instructions/, 'install.yaml still records the file');

	writeFileSync(file(home), 'The Operator wrote this one.\n');
	await install.run([], captureIo(home, env));
	assert.ok(existsSync(file(home)), 'install removed a file install.yaml does not record');
});

test('uninstall removes the retired instruction file that install.yaml records', async () => {
	const { home, env } = machine();
	earlierInstall(home);
	const out = captureIo(home, env);
	await uninstall.run([], out);
	assert.match(out.stdout.join('\n'), /instructions: remove .*kalfa-memory\.md/);
	assert.ok(!existsSync(file(home)));
	assert.ok(existsSync(join(home, '.claude/rules/own.md')));
});

test('the session report holds the Personal layer, also where the harness loads files of rules', async () => {
	const { home, repo, env } = machine();
	personalRule(env, 'Stage files by name.');
	seedRecord(env, personalLayer(memoryHome(env)), 'never-push-to-main', { type: 'fact', summary: 'Never push to main.' });
	projectRule(env, repo);
	await install.run([], captureIo(home, env));

	const withFiles = await start(repo, env, ['instruction-file']);
	assert.match(withFiles!.context!, /Personal layer\nRules:\n- Stage files by name\.[\s\S]*\[fact\] Never push to main\./);
	assert.match(withFiles!.context!, /Project layer \(github\.com\/someone\/project\)\nRules:\n- A project rule\./);
	assert.match(withFiles!.notice!, /memory: 2 rules, 1 index line$/m);
	assert.ok(!existsSync(file(home)), 'the session start wrote an instruction file');

	const without = await start(repo, env, []);
	assert.equal(without!.context, withFiles!.context, 'the Capability does not change the memory part');
});

test('under a cap the rules always load and the index lines fill the room left', async () => {
	const { repo, env } = machine();
	projectRule(env, repo);
	const layer = projectLayer(memoryHome(env), { root: repo, file: undefined });
	for (const n of [1, 2, 3, 4, 5, 6]) seedRecord(env, layer, `fact-number-${n}`, { type: 'fact', summary: `Fact number ${n} ${'x'.repeat(200)}.` });

	const open = await start(repo, env, []);
	assert.doesNotMatch(open!.context!, /Stored/, 'without a cap every line fits the layer budget');

	const capped = await start(repo, env, [], 2400);
	assert.match(capped!.context!, /A project rule\./);
	assert.match(capped!.context!, /Stored: \d more active records/);
	assert.ok(capped!.context!.length <= 2400 - 1500, `${capped!.context!.length} characters`);
});

test('a personal Root Hub leaves the Personal index lines out of the report', async () => {
	const { repo, env } = machine();
	seedRecord(env, personalLayer(memoryHome(env)), 'never-push-to-main', { type: 'fact', summary: 'Never push to main.' });
	assert.match((await start(repo, env, ['instruction-file']))!.context!, /Never push to main\./);
	seedRecord(env, personalLayer(memoryHome(env)), 'root', { type: 'hub', summary: 'The map of the Personal layer.' });
	assert.equal((await start(repo, env, ['instruction-file']))?.context, undefined, 'the Core loads no Personal index line; the memory Module loads the Root Hub');
});

test('under a cap the report keeps room for each Root Hub, also the Personal one, and the other layer still loads its index lines', async () => {
	const { home, repo, env } = machine();
	const layer = projectLayer(memoryHome(env), { root: repo, file: undefined });
	for (const n of [1, 2, 3, 4, 5, 6]) seedRecord(env, layer, `fact-number-${n}`, { type: 'fact', summary: `Fact number ${n} ${'x'.repeat(200)}.` });
	await install.run([], captureIo(home, env));
	const cap = 2500 + 2500;

	const before = await start(repo, env, ['instruction-file'], cap);
	assert.match(before!.context!, /Fact number 6/);
	assert.doesNotMatch(before!.context!, /Stored/, 'without a Root Hub the six lines fit');

	seedRecord(env, personalLayer(memoryHome(env)), 'root', { type: 'hub', summary: 'The map of the Personal layer.' });
	const after = await start(repo, env, ['instruction-file'], cap);
	assert.match(after!.context!, /Project layer \(github\.com\/someone\/project\)\nIndex/, 'a layer without a Root Hub still loads its index lines');
	assert.match(after!.context!, /Stored: [45] more active records/, 'the Personal Root Hub takes 1,500 characters of the room');
	assert.ok(after!.context!.length <= cap - 2500 - 1500, `${after!.context!.length} characters`);

	seedRecord(env, layer, 'root', { type: 'hub', summary: 'The map of the project.' });
	const both = await start(repo, env, ['instruction-file'], cap);
	assert.equal(both?.context, undefined, 'with two Root Hubs the Core loads no index lines');
});

test('the hook records the session start size; doctor reads it against the cap', () => {
	const { repo, env } = machine();
	assert.deepEqual(contextSizes(env, repo), {});
	recordContextSize(env, repo, 'claude', { chars: 9500, cap: 10_000, at: '2026-11-12T20:00:00.000Z' });
	const size = contextSizes(env, repo).claude!;
	assert.equal(contextSizeLine('claude', size), 'claude: 9500 of 10000 characters at the last session start (2026-11-12 20:00); warning: near the cap');
	assert.match(contextSizeLine('claude', { ...size, chars: 18064 }), /problem: over the cap/);
	assert.match(contextSizeLine('claude', { ...size, chars: 6000 }), /within the cap$/);
});

test('the hook warns from 90% of the cap and above it, and records the size', async () => {
	const sized = (chars: number) => ({ name: 'core', handlers: { 'session.start': () => ({ context: 'x'.repeat(chars) }) } });
	const notice = async (chars: number) => {
		const home = tempDir();
		const hook = hookCommand(new Map([['fake', { ...fakeAdapter, contextCap: 1000 }]]), registry(sized(chars)));
		const io = captureIo(home, { HOME: home }, JSON.stringify({ cwd: home }));
		await hook.run(['fake', 'session.start'], io);
		assert.equal(contextSizes({ HOME: home }, undefined).fake!.chars, chars);
		return (JSON.parse(io.stdout.join('')) as { notice: string[] }).notice.join('\n');
	};
	assert.equal(await notice(800), '');
	assert.match(await notice(950), /950 characters, near the fake cap of 1000; close finished Tasks/);
	assert.match(await notice(1200), /1200 characters, over the fake cap of 1000; the agent sees only its start/);
});

test('the session report shows the branch Task in full and only the three most recent others, in one line each', async () => {
	const root = gitRepo({ 'kalfa.yaml': 'schema: 1\n', '.gitignore': '.kalfa/\n' });
	execFileSync('git', ['-C', root, 'checkout', '-q', '-b', 'feat/own']);
	const env = { HOME: tempDir() };
	const task = taskCommand(new Map([['fake', fakeAdapter]]), registry(coreModule));
	await task.run(['start', '--done-when', 'it works', 'Own work'], captureIo(root, env));
	for (const n of [1, 2, 3, 4, 5]) {
		await task.run(['start', '--task', `other-${n}`, '--done-when', `x${n}`, `Other work ${n}`], captureIo(root, env));
		const then = new Date(Date.now() - (10 - n) * 60_000);
		utimesSync(recordPath(root, `other-${n}`), then, then);
	}
	const report = await coreModule.handlers['session.start']!(
		{ name: 'session.start', source: 'startup', harness: 'fake', cwd: root },
		{ project: { root, file: { schema: 1, modules: [], plans: [], settings: {} } }, settings: DEFAULT_SETTINGS, env, capabilities: new Set() } as never,
	);
	const context = report!.context!;
	assert.match(context, /- feat-own: Own work \(0 Section\(s\)\)\n {2}Done when: it works\n- other-5: Other work 5\n- other-4: Other work 4\n- other-3: Other work 3\n- … and 2 more open \(kalfa task list\)/);
	assert.doesNotMatch(context, /Done when: x/);
	assert.match(report!.notice!, /5 other open Tasks/);
});
