import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { memoryCommand } from '../src/cli/commands/memory.ts';
import { KalfaError } from '../src/core/errors.ts';
import { keyFromRemote, memoryHome, personalLayer, projectKey, readLayer } from '../src/core/memory/home.ts';
import { parseMemoryRecord, renderMemoryRecord, slugOf } from '../src/core/memory/record.ts';
import { layerView, renderLayer } from '../src/core/memory/standing.ts';
import { coreModule } from '../src/modules/core.ts';
import { DEFAULT_SETTINGS } from '../src/core/settings.ts';
import { captureIo, gitRepo, tempDir, tempRepo } from './helpers.ts';

/** A machine with its own HOME (so its Memory home), and a repository with an origin. */
function machine(config = 'schema: 1\nmodules: []\n') {
	const home = tempRepo({ '.config/kalfa/config.yaml': config });
	const repo = gitRepo();
	execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', 'git@github.com:Someone/Project.git']);
	return { home, repo, env: { HOME: home } };
}

async function memory(env: NodeJS.ProcessEnv, cwd: string, args: string[], stdin = '') {
	const io = captureIo(cwd, env, stdin);
	try {
		const code = await memoryCommand().run(args, io);
		return { code, out: io.stdout.join('\n'), error: undefined };
	} catch (error) {
		if (error instanceof KalfaError) return { code: 1, out: io.stdout.join('\n'), error: error.message };
		throw error;
	}
}

const gitLog = (env: NodeJS.ProcessEnv) => execFileSync('git', ['-C', memoryHome(env), 'log', '--format=%s'], { encoding: 'utf8' }).trim().split('\n');

test('keyFromRemote reads scp-like, ssh and https remotes, and refuses odd paths', () => {
	assert.equal(keyFromRemote('git@github.com:Someone/Project.git'), 'github.com/someone/project');
	assert.equal(keyFromRemote('https://github.com/someone/project'), 'github.com/someone/project');
	assert.equal(keyFromRemote('ssh://git@gitlab.example.org:2222/group/sub/repo.git'), 'gitlab.example.org/group/sub/repo');
	assert.equal(keyFromRemote('https://github.com/../etc'), undefined);
	assert.equal(keyFromRemote('/srv/git/project.git'), undefined);
});

test('projectKey falls back to the folder name without an origin', () => {
	const repo = gitRepo();
	assert.match(projectKey(repo), /^local\/kalfa-test-/);
});

test('slugOf cuts at a word end', () => {
	assert.equal(slugOf('Stage files by name; never `git add -A <dir>`.'), 'stage-files-by-name-never-git-add-a-dir');
	assert.ok(slugOf('word '.repeat(40)).length <= 60);
});

test('a record survives render and parse; a superseded one needs its successor', () => {
	const record = { header: { schema: 1, type: 'fact', status: 'active', summary: 'The laptop has hybrid graphics.', created: '2026-10-31', confirmed: '2026-10-31' }, body: 'More.' } as const;
	const back = parseMemoryRecord(renderMemoryRecord(record), 'x.md', 'x');
	assert.deepEqual(back.header, record.header);
	assert.equal(back.body, 'More.');
	const bad = renderMemoryRecord({ header: { ...record.header, status: 'superseded' }, body: '' });
	assert.throws(() => parseMemoryRecord(bad, 'x.md', 'x'), /superseded-by/);
});

test('add writes a record into the right layer and commits it in the Memory home', async () => {
	const { repo, env } = machine();
	const personal = await memory(env, repo, ['add', '--type', 'rule', '--layer', 'personal', '--summary', 'Stage files by name.']);
	assert.equal(personal.code, 0, personal.error);
	const project = await memory(env, repo, ['add', '--type', 'fact', '--layer', 'project', '--summary', 'CI needs the leak pattern secret.'], 'Body text.');
	assert.equal(project.code, 0, project.error);
	assert.ok(existsSync(join(memoryHome(env), 'personal', 'stage-files-by-name.md')));
	const fact = join(memoryHome(env), 'projects', 'github.com', 'someone', 'project', 'ci-needs-the-leak-pattern-secret.md');
	assert.match(readFileSync(fact, 'utf8'), /type: fact\nstatus: active[\s\S]*\nBody text\.\n$/);
	assert.deepEqual(gitLog(env), ['add fact ci-needs-the-leak-pattern-secret (github.com/someone/project)', 'add rule stage-files-by-name (personal)']);
});

test('add needs a layer, a known type and a summary; the project layer needs a repository', async () => {
	const { repo, env } = machine();
	assert.match((await memory(env, repo, ['add', '--type', 'rule', '--summary', 'x'])).error ?? '', /--layer/);
	assert.match((await memory(env, repo, ['add', '--type', 'wish', '--layer', 'personal', '--summary', 'x'])).error ?? '', /--type/);
	const outside = await memory(env, tempDir(), ['add', '--type', 'fact', '--layer', 'project', '--summary', 'x']);
	assert.match(outside.error ?? '', /needs a git repository/);
});

test('a write over the rule count or the index bytes is refused; a proposed record does not count', async () => {
	const { repo, env } = machine('schema: 1\nmodules: []\nmemory:\n  personal: {rules: 1, index-bytes: 60}\n');
	assert.equal((await memory(env, repo, ['add', '--type', 'rule', '--layer', 'personal', '--summary', 'Rule one.'])).code, 0);
	const second = await memory(env, repo, ['add', '--type', 'rule', '--layer', 'personal', '--summary', 'Rule two.']);
	assert.match(second.error ?? '', /2 active rules \(limit 1\)/);
	assert.equal((await memory(env, repo, ['add', '--type', 'rule', '--layer', 'personal', '--summary', 'Rule two.', '--proposed'])).code, 0);
	assert.equal((await memory(env, repo, ['add', '--type', 'fact', '--layer', 'personal', '--summary', 'A short fact.'])).code, 0);
	const long = await memory(env, repo, ['add', '--type', 'fact', '--layer', 'personal', '--summary', 'A second fact that does not fit.']);
	assert.match(long.error ?? '', /B of index lines \(limit 60 B\)/);
});

test('a rule longer than rule-chars is refused', async () => {
	const { repo, env } = machine('schema: 1\nmodules: []\nmemory:\n  rule-chars: 20\n');
	const out = await memory(env, repo, ['add', '--type', 'rule', '--layer', 'personal', '--summary', 'Short.'], 'A body that makes it long.');
	assert.match(out.error ?? '', /limit 20/);
});

test('supersede retires the old record, links it, and keeps the rule count', async () => {
	const { repo, env } = machine('schema: 1\nmodules: []\nmemory:\n  personal: {rules: 1}\n');
	await memory(env, repo, ['add', '--type', 'rule', '--layer', 'personal', '--summary', 'Old rule.']);
	const out = await memory(env, repo, ['supersede', 'old-rule', '--summary', 'New rule.']);
	assert.equal(out.code, 0, out.error);
	const records = readLayer(personalLayer(memoryHome(env)));
	assert.deepEqual(
		records.map((r) => [r.id, r.header.status, r.header['superseded-by']]),
		[
			['new-rule', 'active', undefined],
			['old-rule', 'superseded', 'new-rule'],
		],
	);
	assert.match((await memory(env, repo, ['supersede', 'old-rule', '--summary', 'Again.'])).error ?? '', /already superseded/);
});

test('confirm needs a proof, dates the record and writes the proof into the history', async () => {
	const { repo, env } = machine();
	await memory(env, repo, ['add', '--type', 'fact', '--layer', 'project', '--summary', 'A fact.']);
	assert.match((await memory(env, repo, ['confirm', 'a-fact'])).error ?? '', /proof/);
	assert.equal((await memory(env, repo, ['confirm', 'a-fact', 'read', 'it', 'back'])).code, 0);
	const show = await memory(env, repo, ['show', 'a-fact']);
	assert.match(show.out, /History:\n- \d{4}-\d\d-\d\d confirm a-fact: read it back\n- \d{4}-\d\d-\d\d add fact a-fact/);
});

test('close needs a reason, takes the record out of the session start and keeps it in list and history', async () => {
	const { repo, env } = machine();
	await memory(env, repo, ['add', '--type', 'open', '--layer', 'personal', '--summary', 'An open item.']);
	assert.match((await memory(env, repo, ['close', 'an-open-item'])).error ?? '', /reason/);
	assert.equal((await memory(env, repo, ['close', 'an-open-item', 'the', 'work', 'is', 'done'])).code, 0);
	const layer = personalLayer(memoryHome(env));
	const records = readLayer(layer);
	assert.deepEqual(records.map((r) => r.header.status), ['closed']);
	assert.deepEqual(layerView(layer, records, { rules: 10, 'index-bytes': 1000 }).index, []);
	assert.match((await memory(env, repo, ['list'])).out, /no active Memory records/);
	assert.match((await memory(env, repo, ['list', '--status', 'closed'])).out, /an-open-item {2}open {2}closed/);
	assert.match((await memory(env, repo, ['show', 'an-open-item'])).out, /History:\n- \d{4}-\d\d-\d\d close an-open-item: the work is done/);
	for (const args of [['close', 'an-open-item', 'again'], ['confirm', 'an-open-item', 'looked'], ['supersede', 'an-open-item', '--summary', 'New.']]) {
		assert.match((await memory(env, repo, args)).error ?? '', /is closed/);
	}
});

test('activate makes proposed records active, one commit per layer, and checks every budget first', async () => {
	const { repo, env } = machine('schema: 1\nmodules: []\nmemory:\n  personal: {rules: 2}\n');
	for (const summary of ['Rule one.', 'Rule two.']) await memory(env, repo, ['add', '--type', 'rule', '--layer', 'personal', '--summary', summary, '--proposed']);
	await memory(env, repo, ['add', '--type', 'fact', '--layer', 'project', '--summary', 'A fact.', '--proposed']);
	assert.match((await memory(env, repo, ['activate', 'no-such'])).error ?? '', /no proposed record 'no-such'/);

	const one = await memory(env, repo, ['activate', 'rule-one']);
	assert.equal(one.code, 0, one.error);
	const status = () => readLayer(personalLayer(memoryHome(env))).map((r) => [r.id, r.header.status]);
	assert.deepEqual(status(), [
		['rule-one', 'active'],
		['rule-two', 'proposed'],
	]);

	const all = await memory(env, repo, ['activate']);
	assert.equal(all.code, 0, all.error);
	assert.match(all.out, /Activated 1 record\(s\) in the personal layer\nActivated 1 record\(s\) in the github.com\/someone\/project layer/);
	assert.deepEqual(gitLog(env).slice(0, 3), [
		'activate 1 proposed record(s) (github.com/someone/project)',
		'activate 1 proposed record(s) (personal)',
		'activate 1 proposed record(s) (personal)',
	]);
	assert.equal((await memory(env, repo, ['activate'])).out, 'no proposed records here');

	await memory(env, repo, ['add', '--type', 'rule', '--layer', 'personal', '--summary', 'Rule three.', '--proposed']);
	const over = await memory(env, repo, ['activate']);
	assert.match(over.error ?? '', /3 active rules \(limit 2\)/);
	assert.equal(readLayer(personalLayer(memoryHome(env))).find((r) => r.id === 'rule-three')?.header.status, 'proposed', 'nothing is written over budget');
});

test('an id in two layers needs --layer; hand edits are committed on their own first', async () => {
	const { repo, env } = machine();
	await memory(env, repo, ['add', '--type', 'fact', '--layer', 'personal', '--summary', 'Same.']);
	await memory(env, repo, ['add', '--type', 'fact', '--layer', 'project', '--summary', 'Same.']);
	assert.match((await memory(env, repo, ['show', 'same'])).error ?? '', /more than one layer/);
	const file = join(memoryHome(env), 'personal', 'same.md');
	writeFileSync(file, readFileSync(file, 'utf8').replace('Same.', 'Same, edited.'));
	assert.equal((await memory(env, repo, ['confirm', 'same', '--layer', 'personal', 'looked'])).code, 0);
	assert.deepEqual(gitLog(env).slice(0, 2), ['confirm same: looked', 'hand edits']);
});

test('list shows the active records of every layer this directory sees', async () => {
	const { repo, env } = machine();
	assert.match((await memory(env, repo, ['list'])).out, /no Memory home yet/);
	await memory(env, repo, ['add', '--type', 'open', '--layer', 'project', '--summary', 'Decide the backup remote.']);
	await memory(env, repo, ['add', '--type', 'rule', '--layer', 'personal', '--summary', 'Proposed rule.', '--proposed']);
	const out = (await memory(env, repo, ['list'])).out;
	assert.match(out, /^github\.com\/someone\/project:\n {2}decide-the-backup-remote {2}open {2}active/);
	assert.doesNotMatch(out, /proposed-rule/);
	assert.match((await memory(env, repo, ['list', '--status', 'proposed'])).out, /proposed-rule/);
});

test('the layer view loads every rule, fills the index newest-confirmed first, and reports what it left out', () => {
	const layer = personalLayer('/nowhere');
	const rec = (id: string, type: string, confirmed: string, status = 'active') =>
		({ id, header: { schema: 1, type, status, summary: `${id} summary`, created: '2026-01-01', confirmed }, body: '' }) as never;
	const view = layerView(layer, [rec('r1', 'rule', '2026-01-01'), rec('r2', 'rule', '2026-01-01'), rec('old', 'fact', '2026-02-01'), rec('new', 'decision', '2026-03-01'), rec('p', 'fact', '2026-04-01', 'proposed')], {
		rules: 1,
		'index-bytes': 40,
	});
	assert.equal(view.rules.length, 2);
	assert.equal(view.overRules, 1);
	assert.deepEqual(view.index, ['- [decision] new summary (new)']);
	assert.equal(view.dropped, 1);
	assert.match(renderLayer(view), /^Personal layer\nRules:\n- r1 summary \(r1\)\n- r2 summary \(r2\)\n\nIndex/);
});

test('session.start injects Standing memory, also outside a repository, and names a layer over budget', async () => {
	const { repo, env } = machine();
	await memory(env, repo, ['add', '--type', 'rule', '--layer', 'personal', '--summary', 'Stage files by name.']);
	await memory(env, repo, ['add', '--type', 'fact', '--layer', 'project', '--summary', 'A project fact.']);
	const context = (project: unknown, settings = DEFAULT_SETTINGS) =>
		coreModule.handlers['session.start']!({ name: 'session.start', source: 'startup', harness: 'claude', cwd: repo }, { project, settings, env, capabilities: new Set() } as never);

	const inside = await context({ root: repo, file: undefined });
	assert.match(inside?.context ?? '', /Personal layer\nRules:\n- Stage files by name\. \(stage-files-by-name\)/);
	assert.match(inside?.context ?? '', /Project layer \(github\.com\/someone\/project\)\nIndex[^\n]*\n- \[fact\] A project fact\. \(a-project-fact\)/);
	assert.match(inside?.notice ?? '', /memory: 1 rule, 1 index line/);

	const outside = await context(undefined);
	assert.match(outside?.context ?? '', /Personal layer/);
	assert.doesNotMatch(outside?.context ?? '', /Project layer/);

	const tight = await context({ root: repo, file: undefined }, { ...DEFAULT_SETTINGS, memory: { personal: { rules: 0 as never } } } as never);
	assert.match(tight?.context ?? '', /Stage files by name/, 'an over-budget rule still loads');
	assert.match(tight?.notice ?? '', /the personal layer is over budget: 1 rules, limit 0/);
});
