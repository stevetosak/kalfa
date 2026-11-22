import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { memoryCommand } from '../src/cli/commands/memory.ts';
import { KalfaError } from '../src/core/errors.ts';
import { keyFromRemote, memoryHome, personalLayer, projectKey, projectLayerOfKey, readLayer } from '../src/core/memory/home.ts';
import { readUsage } from '../src/core/memory/usage.ts';
import { parseMemoryRecord, renderMemoryRecord, slugOf } from '../src/core/memory/record.ts';
import { layerView, renderLayer } from '../src/core/memory/standing.ts';
import { coreModule } from '../src/modules/core.ts';
import { DEFAULT_SETTINGS } from '../src/core/settings.ts';
import { captureIo, gitRepo, legacyRecord, tempDir, tempRepo } from './helpers.ts';

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
	const personal = await memory(env, repo, ['add', '--type', 'hub', '--layer', 'personal', '--summary', 'Git habits.'], 'Stage by name: [[stage-files-by-name]].');
	assert.equal(personal.code, 0, personal.error);
	const project = await memory(env, repo, ['add', '--type', 'fact', '--layer', 'project', '--summary', 'CI needs the leak pattern secret.'], 'Body text.');
	assert.equal(project.code, 0, project.error);
	assert.match(readFileSync(join(memoryHome(env), 'personal', 'git-habits.md'), 'utf8'), /type: hub\nstatus: active[\s\S]*\nStage by name: \[\[stage-files-by-name\]\]\.\n$/);
	const fact = join(memoryHome(env), 'projects', 'github.com', 'someone', 'project', 'ci-needs-the-leak-pattern-secret.md');
	assert.match(readFileSync(fact, 'utf8'), /type: fact\nstatus: active[\s\S]*\nBody text\.\n$/);
	assert.deepEqual(gitLog(env), ['add fact ci-needs-the-leak-pattern-secret (github.com/someone/project)', 'add hub git-habits (personal)']);
});

test('add needs a layer, a known type and a summary; the project layer needs a repository', async () => {
	const { repo, env } = machine();
	assert.match((await memory(env, repo, ['add', '--type', 'fact', '--summary', 'x'])).error ?? '', /--layer/);
	assert.match((await memory(env, repo, ['add', '--type', 'wish', '--layer', 'personal', '--summary', 'x'])).error ?? '', /--type is one of fact, decision, open, hub/);
	const outside = await memory(env, tempDir(), ['add', '--type', 'fact', '--layer', 'project', '--summary', 'x']);
	assert.match(outside.error ?? '', /needs a git repository/);
});

test('a new write takes no rule type and no proposed status; the refusal says where a rule goes', async () => {
	const { repo, env } = machine();
	const rule = await memory(env, repo, ['add', '--type', 'rule', '--layer', 'personal', '--summary', 'Stage files by name.']);
	assert.match(rule.error ?? '', /^a rule is not a Memory record \(ADR 0003\): write it with kalfa rule add --layer personal\|project$/);
	const proposed = await memory(env, repo, ['add', '--type', 'fact', '--layer', 'personal', '--summary', 'A fact.', '--proposed']);
	assert.match(proposed.error ?? '', /--proposed is gone \(ADR 0003\): the agent writes what it finds as an active record/);
	assert.equal(existsSync(memoryHome(env)), false, 'nothing was written');
});

test('a write is never refused for space: over the index bytes it is stored', async () => {
	const { repo, env } = machine('schema: 1\nmodules: []\nmemory:\n  personal: {index-bytes: 60}\n');
	for (const summary of ['A short fact.', 'A second fact that does not fit.', 'A third fact that does not fit either.']) {
		const out = await memory(env, repo, ['add', '--type', 'fact', '--layer', 'personal', '--summary', summary]);
		assert.equal(out.code, 0, out.error);
	}
	assert.equal((await memory(env, repo, ['supersede', 'a-short-fact', '--summary', 'A short fact, now much longer than the budget allows.'])).code, 0);
	assert.equal(readLayer(personalLayer(memoryHome(env))).filter((r) => r.header.status === 'active').length, 3);
});

test('supersede retires the old record and links it; the successor keeps the type', async () => {
	const { repo, env } = machine();
	await memory(env, repo, ['add', '--type', 'decision', '--layer', 'personal', '--summary', 'Old decision.']);
	const out = await memory(env, repo, ['supersede', 'old-decision', '--summary', 'New decision.']);
	assert.equal(out.code, 0, out.error);
	const records = readLayer(personalLayer(memoryHome(env)));
	assert.deepEqual(
		records.map((r) => [r.id, r.header.type, r.header.status, r.header['superseded-by']]),
		[
			['new-decision', 'decision', 'active', undefined],
			['old-decision', 'decision', 'superseded', 'new-decision'],
		],
	);
	assert.match((await memory(env, repo, ['supersede', 'old-decision', '--summary', 'Again.'])).error ?? '', /already superseded/);
});

test('a superseded proposed record gets an active successor; a rule record is refused and named for the migration', async () => {
	const { repo, env } = machine();
	const layer = personalLayer(memoryHome(env));
	legacyRecord(env, layer, 'waiting', { type: 'fact', status: 'proposed', summary: 'A waiting fact.' });
	legacyRecord(env, layer, 'old-rule', { type: 'rule', summary: 'Stage files by name.' });
	const status = (id: string) => readLayer(layer).find((r) => r.id === id)?.header.status;
	assert.equal((await memory(env, repo, ['supersede', 'waiting', '--summary', 'A decided fact.'])).code, 0);
	assert.deepEqual([status('a-decided-fact'), status('waiting')], ['active', 'superseded']);
	const rule = await memory(env, repo, ['supersede', 'old-rule', '--summary', 'Stage by name.']);
	assert.match(rule.error ?? '', /^'old-rule' is a rule record, and a rule is not a Memory record .*kalfa rule add.*; kalfa rule migrate moves this one/);
	assert.equal(status('old-rule'), 'active');
	assert.equal(status('stage-by-name'), undefined, 'no successor was written');
});

test('confirm needs a proof, dates the record and writes the proof into the history', async () => {
	const { repo, env } = machine();
	await memory(env, repo, ['add', '--type', 'fact', '--layer', 'project', '--summary', 'A fact.']);
	assert.match((await memory(env, repo, ['confirm', 'a-fact'])).error ?? '', /proof/);
	assert.deepEqual(readUsage(projectLayerOfKey(memoryHome(env), 'github.com/someone/project'), env), {}, 'nothing is used before a show');
	assert.equal((await memory(env, repo, ['confirm', 'a-fact', 'read', 'it', 'back'])).code, 0);
	const show = await memory(env, repo, ['show', 'a-fact']);
	assert.deepEqual(Object.keys(readUsage(projectLayerOfKey(memoryHome(env), 'github.com/someone/project'), env)), ['a-fact'], 'show marks the record used');
	assert.match(show.out, /History:\n- \d{4}-\d\d-\d\d confirm a-fact: read it back\n- \d{4}-\d\d-\d\d add fact a-fact/);
});

test('show lists the linked records to --depth, both ways and across layers; only the record shown is used', async () => {
	const { repo, env } = machine();
	await memory(env, repo, ['add', '--type', 'hub', '--layer', 'personal', '--summary', 'Git habits.', '--id', 'git-habits'], 'Stage by name: [[stage-by-name]]. Gone: [[no-such]].');
	await memory(env, repo, ['add', '--type', 'fact', '--layer', 'personal', '--summary', 'Stage files by name.', '--id', 'stage-by-name'], 'A folder can hold [[untracked]] files.');
	await memory(env, repo, ['add', '--type', 'fact', '--layer', 'personal', '--summary', 'Some files are untracked on purpose.', '--id', 'untracked']);
	await memory(env, repo, ['add', '--type', 'decision', '--layer', 'project', '--summary', 'CI stages by name.', '--id', 'ci-stages'], 'As [[personal:git-habits]] says.');

	const one = (await memory(env, repo, ['show', 'git-habits'])).out;
	assert.match(
		one,
		/\nStage by name: \[\[stage-by-name\]\]\. Gone: \[\[no-such\]\]\.\n\nLinks, depth 1 \(→ it links to, ← links to it\):\n- → \[fact\] Stage files by name\. \(stage-by-name\)\n- → \[\[no-such\]\]: no such record\n- ← \[decision\] CI stages by name\. \(ci-stages, github\.com\/someone\/project\)\n\nHistory:/,
	);
	assert.doesNotMatch(one, /untracked on purpose/, 'depth 1 stops at the neighbours');
	assert.match((await memory(env, repo, ['show', 'git-habits', '--depth', '2'])).out, /- → \[fact\] Stage files by name\. \(stage-by-name\)\n {2}- → \[fact\] Some files are untracked on purpose\. \(untracked\)\n/);
	assert.doesNotMatch((await memory(env, repo, ['show', 'git-habits', '--depth', '0'])).out, /Links/);
	assert.match((await memory(env, repo, ['show', 'git-habits', '--depth', '3'])).error ?? '', /--depth is 0, 1, 2, not '3'/);
	assert.deepEqual(Object.keys(readUsage(personalLayer(memoryHome(env)), env)), ['git-habits'], 'a summary line is not a read');
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

test('activate makes proposed records active, one commit per layer', async () => {
	const { repo, env } = machine('schema: 1\nmodules: []\nmemory:\n  personal: {rules: 2}\n');
	const personal = personalLayer(memoryHome(env));
	for (const id of ['rule-one', 'rule-two']) legacyRecord(env, personal, id, { type: 'rule', status: 'proposed', summary: `${id}.` });
	legacyRecord(env, projectLayerOfKey(memoryHome(env), 'github.com/someone/project'), 'a-fact', { type: 'fact', status: 'proposed', summary: 'A fact.' });
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

	legacyRecord(env, personal, 'rule-three', { type: 'rule', status: 'proposed', summary: 'Rule three.' });
	assert.equal((await memory(env, repo, ['activate'])).code, 0, 'over the rule count it is still activated');
	assert.equal(readLayer(personalLayer(memoryHome(env))).find((r) => r.id === 'rule-three')?.header.status, 'active');
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
	legacyRecord(env, personalLayer(memoryHome(env)), 'proposed-rule', { type: 'rule', status: 'proposed', summary: 'Proposed rule.' });
	const out = (await memory(env, repo, ['list'])).out;
	assert.match(out, /^github\.com\/someone\/project:\n {2}decide-the-backup-remote {2}open {2}active/);
	assert.doesNotMatch(out, /proposed-rule/);
	assert.match((await memory(env, repo, ['list', '--status', 'proposed'])).out, /proposed-rule/);
});

test('the layer view loads every rule, fills the index by the later of use and confirmation, and Stores the rest', () => {
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
	assert.deepEqual(view.stored.map((r: { id: string }) => r.id), ['old']);
	assert.match(renderLayer(view), /^Personal layer\nRules:\n- r1 summary \(r1\)\n- r2 summary \(r2\)\n\nIndex/);
	assert.match(renderLayer(view), /Stored: 1 more active record, not loaded; .*kalfa memory search/);
	const records = [rec('old', 'fact', '2026-02-01'), rec('new', 'decision', '2026-03-01')];
	const used = layerView(layer, records, { rules: 1, 'index-bytes': 40 }, { old: '2026-05-01' });
	assert.deepEqual(used.index, ['- [fact] old summary (old)'], 'a record used later than the other was confirmed ranks first');
});

test('session.start injects Standing memory, also outside a repository, and names a layer over budget', async () => {
	const { repo, env } = machine();
	legacyRecord(env, personalLayer(memoryHome(env)), 'stage-files-by-name', { type: 'rule', summary: 'Stage files by name.' });
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
	assert.match(tight?.notice ?? '', /the personal layer has 1 rules, limit 0 \(all loaded/);

	const small = await context({ root: repo, file: undefined }, { ...DEFAULT_SETTINGS, memory: { project: { 'index-bytes': 10 } } } as never);
	assert.match(small?.context ?? '', /Stored: 1 more active record/);
	assert.match(small?.notice ?? '', /memory: 1 rule, 0 index lines, 1 Stored/);
	assert.doesNotMatch(small?.notice ?? '', /over budget/, 'a Stored tier is normal, not an alarm');
});
