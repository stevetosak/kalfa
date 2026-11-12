import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { memoryHome, personalLayer, projectLayerOfKey, readLayer } from '../../src/core/memory/home.ts';
import type { HandlerContext } from '../../src/core/modules.ts';
import { loadProject } from '../../src/core/project.ts';
import { loadSettings } from '../../src/core/settings.ts';
import { KalfaError } from '../../src/core/errors.ts';
import { fakeAdapter } from '../../test/fakes.ts';
import { captureIo, gitRepo, tempRepo } from '../../test/helpers.ts';
import { openIndex } from '../memory/search.ts';
import { memorySettings } from '../memory/settings.ts';
import { deferCommand } from './command.ts';
import { itemPath, scanDeferred } from './deferred.ts';
import { plansModule } from './handlers.ts';

const KEY = 'github.com/someone/project';

/** A machine with the plans Module on, and a repository with an origin. */
function machine(modules = '[plans]') {
	const home = tempRepo({ '.config/kalfa/config.yaml': `schema: 1\nmodules: ${modules}\n` });
	const repo = gitRepo({ 'kalfa.yaml': 'schema: 1\nmodules: []\n' });
	execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', 'git@github.com:Someone/Project.git']);
	return { repo, env: { HOME: home } as NodeJS.ProcessEnv };
}

async function defer(cwd: string, env: NodeJS.ProcessEnv, args: string[], stdin = '') {
	const io = captureIo(cwd, env, stdin);
	try {
		const code = await deferCommand().run(args, io);
		return { code, out: io.stdout.join('\n'), err: io.stderr.join('\n'), error: undefined as string | undefined };
	} catch (error) {
		if (error instanceof KalfaError) return { code: 1, out: io.stdout.join('\n'), err: io.stderr.join('\n'), error: error.message };
		throw error;
	}
}

const homeLog = (env: NodeJS.ProcessEnv) => execFileSync('git', ['-C', memoryHome(env), 'log', '--format=%s'], { encoding: 'utf8' }).trim().split('\n');

function contextOf(repo: string, env: NodeJS.ProcessEnv): HandlerContext {
	return { project: loadProject(repo), settings: loadSettings(env), env, capabilities: fakeAdapter.capabilities };
}

test('defer add writes one item file in the layer\'s deferred folder, not a Memory record, and commits it', async () => {
	const { repo, env } = machine();
	const add = await defer(repo, env, ['add', '--layer', 'project', '--summary', 'DNS writes through kluster', '--when', 'a second domain is needed'], 'Why: one domain today.\nSource: PR #12.');
	assert.equal(add.code, 0, add.error);
	const layer = projectLayerOfKey(memoryHome(env), KEY);
	const text = readFileSync(itemPath(layer, 'dns-writes-through-kluster'), 'utf8');
	assert.match(text, /^---\nschema: 1\nstatus: open\nsummary: DNS writes through kluster\ncreated: \d{4}-\d\d-\d\d\ncondition: a second domain is needed\n---\n\nWhy: one domain today\.\nSource: PR #12\.\n$/);
	assert.deepEqual(readLayer(layer), [], 'an item is not a Memory record');
	assert.deepEqual(homeLog(env), [`defer add dns-writes-through-kluster (${KEY})`]);
	assert.match((await defer(repo, env, ['add', '--summary', 'x'])).error ?? '', /--layer/);
	assert.match((await defer(repo, env, ['add', '--layer', 'personal', '--summary', 'x', '--id', 'Bad Id'])).error ?? '', /lower-case/);
});

test('defer list shows open items of both layers; take and drop leave the list and keep the file', async () => {
	const { repo, env } = machine();
	await defer(repo, env, ['add', '--layer', 'personal', '--summary', 'Quiz feature']);
	await defer(repo, env, ['add', '--layer', 'project', '--summary', 'Fork the parser']);
	await defer(repo, env, ['add', '--layer', 'project', '--summary', 'Deploy action']);
	assert.match((await defer(repo, env, ['list'])).out, /^personal:\n- quiz-feature \(\d{4}-\d\d-\d\d\): Quiz feature\ngithub\.com\/someone\/project:\n- deploy-action [^\n]*\n- fork-the-parser /, 'oldest first, then by id');
	assert.match((await defer(repo, env, ['drop', 'fork-the-parser'])).error ?? '', /reason/);
	assert.equal((await defer(repo, env, ['drop', 'fork-the-parser', 'upstream', 'fixed', 'it'])).code, 0);
	assert.equal((await defer(repo, env, ['take', 'deploy-action', 'Plan', 'docs/plans/deploy.md'])).code, 0);
	assert.match((await defer(repo, env, ['take', 'deploy-action'])).error ?? '', /already taken/);
	const list = (await defer(repo, env, ['list'])).out;
	assert.doesNotMatch(list, /fork-the-parser|deploy-action/);
	assert.match((await defer(repo, env, ['list', '--all'])).out, /fork-the-parser [^\n]*\[dropped \d{4}-\d\d-\d\d\]/);
	assert.match((await defer(repo, env, ['show', 'fork-the-parser'])).out, /status: dropped\n[\s\S]*closed: \d{4}/);
	assert.deepEqual(homeLog(env).slice(0, 2), [`defer take deploy-action (${KEY}): Plan docs/plans/deploy.md`, `defer drop fork-the-parser (${KEY}): upstream fixed it`]);
	assert.equal(scanDeferred(projectLayerOfKey(memoryHome(env), KEY)).items.length, 2, 'the files stay');
});

test('the session start lists the open items beside the Plans; a broken file is named, not fatal', async () => {
	const { repo, env } = machine();
	assert.equal(plansModule.handlers['session.start']({ name: 'session.start', harness: 'fake', cwd: repo, source: 'startup' }, contextOf(repo, env)), undefined);
	await defer(repo, env, ['add', '--layer', 'personal', '--summary', 'Quiz feature', '--when', 'the Operator asks']);
	writeFileSync(itemPath(personalLayer(memoryHome(env)), 'broken'), 'no header');
	const result = plansModule.handlers['session.start']({ name: 'session.start', harness: 'fake', cwd: repo, source: 'startup' }, contextOf(repo, env));
	assert.match(result?.context ?? '', /^Deferred items \(kalfa defer list\)[^\n]*\n- quiz-feature \(\d{4}-\d\d-\d\d, personal\): Quiz feature\n {2}when: the Operator asks$/);
	assert.match(result?.notice ?? '', /kalfa: plans: 1 deferred item\nkalfa: deferred items left out: .*broken\.md/);
});

test('memory search finds a deferred item and names how to read it', async () => {
	const { repo, env } = machine();
	await defer(repo, env, ['add', '--layer', 'project', '--summary', 'Walrus gateway rewrite'], 'Waits for the Envoy upgrade.');
	const hits = openIndex({ project: loadProject(repo), env, archives: memorySettings.parse({}).archives }).search('walrus envoy', 5);
	assert.deepEqual(
		hits.map((h) => `${h.kind} ${h.title} — ${h.ref}`),
		[`deferred deferred: Walrus gateway rewrite — kalfa defer show walrus-gateway-rewrite (${KEY})`],
	);
});

test('kalfa defer is refused where the plans Module is off', async () => {
	const { repo, env } = machine('[]');
	assert.match((await defer(repo, env, ['list'])).error ?? '', /the plans Module is not on here/);
});
