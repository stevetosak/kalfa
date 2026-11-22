import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { keyFromRemote, memoryHome, personalLayer, projectKey, projectLayerOfKey } from '../src/core/memory/home.ts';
import { parseMemoryRecord, renderMemoryRecord, slugOf } from '../src/core/memory/record.ts';
import { rootHubOf, rootRecord } from '../src/core/memory/root-hub.ts';
import { budgetProblem, layerView, renderLayer } from '../src/core/memory/standing.ts';
import { coreModule } from '../src/modules/core.ts';
import { DEFAULT_SETTINGS } from '../src/core/settings.ts';
import { gitRepo, legacyRecord, seedRecord, tempRepo } from './helpers.ts';

/** A machine with its own HOME (so its Memory home), and a repository with an origin. */
function machine(config = 'schema: 1\nmodules: []\n') {
	const home = tempRepo({ '.config/kalfa/config.yaml': config });
	const repo = gitRepo();
	execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', 'git@github.com:Someone/Project.git']);
	return { home, repo, env: { HOME: home } };
}

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

/** A record for a view or a Root Hub test; `next` makes it superseded by that id. */
const record = (id: string, type: string, status = 'active', next?: string) =>
	({ id, header: { schema: 1, type, status, summary: `${id} summary`, created: '2026-01-01', confirmed: '2026-01-01', ...(next ? { 'superseded-by': next } : {}) }, body: '' }) as never;

test('the Root Hub is the record root, or the end of its supersede chain, when that is an active hub', () => {
	assert.equal(rootHubOf([record('a-fact', 'fact')]), undefined, 'no root record');
	assert.equal(rootHubOf([record('root', 'hub'), record('a-fact', 'fact')])?.id, 'root');
	assert.equal(rootHubOf([record('root', 'hub', 'superseded', 'root-2'), record('root-2', 'hub', 'superseded', 'kalfa-map'), record('kalfa-map', 'hub')])?.id, 'kalfa-map');
	assert.equal(rootHubOf([record('root', 'hub', 'superseded', 'root-2'), record('root-2', 'hub', 'closed')]), undefined, 'a closed Root Hub does not load');
	assert.equal(rootRecord([record('root', 'hub', 'superseded', 'root-2'), record('root-2', 'hub', 'closed')])?.id, 'root-2');
	assert.equal(rootHubOf([record('root', 'fact')]), undefined, 'only a hub is a Root Hub');
	assert.equal(rootRecord([record('root', 'fact')])?.id, 'root', 'the lint still sees the root record');
	assert.equal(rootHubOf([record('root', 'hub', 'proposed')]), undefined);
	assert.equal(rootRecord([record('root', 'hub', 'superseded', 'gone')]), undefined, 'a chain that names no record');
	assert.equal(rootRecord([record('root', 'hub', 'superseded', 'b'), record('b', 'hub', 'superseded', 'root')]), undefined, 'a chain that comes back on itself');
});

test('a layer with a Root Hub loads its rules and no index lines, has no Stored tier and is not over its budget', () => {
	const layer = personalLayer('/nowhere');
	const records = [record('r1', 'rule'), record('root', 'hub'), record('a-fact', 'fact'), record('a-decision', 'decision')];
	const view = layerView(layer, records, { rules: 10, 'index-bytes': 10 });
	assert.equal(view.rootHub?.id, 'root');
	assert.deepEqual(view.index, []);
	assert.deepEqual(view.stored, []);
	assert.equal(view.indexBytes, 0);
	assert.equal(renderLayer(view), 'Personal layer\nRules:\n- r1 summary (r1)');
	const budgets = { personal: { rules: 10, 'index-bytes': 10 }, project: { rules: 10, 'index-bytes': 10 }, ruleChars: 600, rootHubChars: 1500 };
	assert.equal(budgetProblem(layer, records, budgets), undefined);
	assert.match(budgetProblem(layer, records.filter((r) => (r as { id: string }).id !== 'root'), budgets) ?? '', /B of index lines/, 'the same layer without its Root Hub is over budget');
});

test('session.start injects Standing memory, also outside a repository, and names a layer over budget', async () => {
	const { repo, env } = machine();
	legacyRecord(env, personalLayer(memoryHome(env)), 'stage-files-by-name', { type: 'rule', summary: 'Stage files by name.' });
	seedRecord(env, projectLayerOfKey(memoryHome(env), 'github.com/someone/project'), 'a-project-fact', { type: 'fact', summary: 'A project fact.' });
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
