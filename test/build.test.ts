import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { claudeAdapter } from '../src/adapters/claude/adapter.ts';
import { buildCommand } from '../src/cli/commands/build.ts';
import { captureIo, gitRepo, tempDir, tempRepo } from './helpers.ts';

const modulesDir = tempRepo({
	'guardrails/module.yaml': "schema: 1\ndescription: Hard rules.\ncommands:\n  ask: ['terraform *', 'kubectl apply *']\n",
	'guardrails/skills/push-gate/SKILL.md': '---\nname: push-gate\n---\nGate.\n',
	'guardrails/skills/push-gate/scripts/check.sh': 'echo ok\n',
	'guardrails/rules/infra.md': "---\npaths: ['core/**/*.yaml']\n---\nPin every image.\n",
	'docs/module.yaml': 'schema: 1\ndescription: Docs.\n',
	'docs/rules/always.md': 'Write a Log.\n',
	'clash/module.yaml': 'schema: 1\ndescription: Clash.\n',
	'clash/skills/push-gate/SKILL.md': 'other\n',
});

const build = buildCommand(new Map([['claude', claudeAdapter]]), () => [modulesDir]);

function repo(modules: string, ignore = '.kalfa/\n.claude/\n', files: Record<string, string> = {}): string {
	return gitRepo({ 'kalfa.yaml': `schema: 1\nmodules: ${modules}\n`, '.gitignore': ignore, ...files });
}

async function run(root: string, ...args: string[]) {
	const io = captureIo(root);
	const code = await build.run(args, io);
	return { code, out: io.stdout.join('\n') };
}

const setModules = (root: string, modules: string) => writeFileSync(join(root, 'kalfa.yaml'), `schema: 1\nmodules: ${modules}\n`);
const read = (root: string, path: string) => readFileSync(join(root, path), 'utf8');
const SETTINGS = '.claude/settings.local.json';

test('a build writes skills, rules and approvals, keeps the Operator entries, and a second build changes nothing', async () => {
	const root = repo('[guardrails, docs]', undefined, { [SETTINGS]: JSON.stringify({ permissions: { allow: ['Bash(ls)'], ask: ['Bash(terraform *)'] }, model: 'x' }) });
	const first = await run(root);
	assert.equal(first.code, 0);
	assert.match(first.out, /write \.claude\/skills\/push-gate\/scripts\/check\.sh/);
	assert.match(first.out, /approvals: add ask Bash\(kubectl apply \*\)/);
	assert.doesNotMatch(first.out, /add ask Bash\(terraform/);
	assert.equal(read(root, '.claude/skills/push-gate/SKILL.md'), '---\nname: push-gate\n---\nGate.\n');
	assert.equal(
		read(root, '.claude/rules/kalfa-guardrails-infra.md'),
		"---\npaths:\n  - core/**/*.yaml\n---\n<!-- Written by kalfa build from the Module 'guardrails'. Change the Module, not this file. -->\n\nPin every image.\n",
	);
	assert.match(read(root, '.claude/rules/kalfa-docs-always.md'), /^<!-- Written by kalfa build[\s\S]*Write a Log\.\n$/);
	assert.deepEqual(JSON.parse(read(root, SETTINGS)), { permissions: { allow: ['Bash(ls)'], ask: ['Bash(terraform *)', 'Bash(kubectl apply *)'] }, model: 'x' });

	assert.deepEqual(await run(root), { code: 0, out: 'claude:\n  4 file(s) unchanged' });
});

test('turning a Module off removes its files and only the approvals kalfa added', async () => {
	const root = repo('[guardrails, docs]', undefined, { [SETTINGS]: JSON.stringify({ permissions: { ask: ['Bash(terraform *)'] } }) });
	await run(root);
	setModules(root, '[docs]');
	const out = (await run(root)).out;
	assert.match(out, /remove \.claude\/skills\/push-gate\/scripts\/check\.sh/);
	assert.match(out, /approvals: remove ask Bash\(kubectl apply \*\)/);
	assert.equal(existsSync(join(root, '.claude/skills')), false, 'empty folders go too');
	assert.equal(existsSync(join(root, '.claude/rules/kalfa-docs-always.md')), true);
	assert.deepEqual(JSON.parse(read(root, SETTINGS)), { permissions: { ask: ['Bash(terraform *)'] } });
});

test('with every Module off, a settings file that only kalfa wrote is removed, with its folder', async () => {
	const root = repo('[guardrails]');
	await run(root);
	assert.deepEqual(JSON.parse(read(root, SETTINGS)), { permissions: { ask: ['Bash(terraform *)', 'Bash(kubectl apply *)'] } });
	setModules(root, '[]');
	await run(root);
	assert.equal(existsSync(join(root, '.claude')), false);
});

test('a file changed by hand is refused, nothing is written, and --force overwrites it', async () => {
	const root = repo('[guardrails]');
	await run(root);
	writeFileSync(join(root, '.claude/rules/kalfa-guardrails-infra.md'), 'my edit\n');
	setModules(root, '[guardrails, docs]');
	await assert.rejects(run(root), /kalfa build changed nothing:\n- \.claude\/rules\/kalfa-guardrails-infra\.md: changed by hand since the last build/);
	assert.equal(existsSync(join(root, '.claude/rules/kalfa-docs-always.md')), false);
	assert.equal((await run(root, '--force')).code, 0);
	assert.match(read(root, '.claude/rules/kalfa-guardrails-infra.md'), /Pin every image/);
});

test('a file kalfa did not write is never overwritten', async () => {
	const root = repo('[guardrails]', undefined, { '.claude/skills/push-gate/SKILL.md': 'my own skill\n' });
	await assert.rejects(run(root, '--force'), /push-gate\/SKILL\.md: exists and kalfa did not write it/);
	assert.equal(read(root, '.claude/skills/push-gate/SKILL.md'), 'my own skill\n');
});

test('a file that no Module writes any more but was changed by hand is kept', async () => {
	const root = repo('[docs]');
	await run(root);
	writeFileSync(join(root, '.claude/rules/kalfa-docs-always.md'), 'now mine\n');
	setModules(root, '[]');
	assert.match((await run(root)).out, /keep \.claude\/rules\/kalfa-docs-always\.md \(no Module writes it any more/);
	assert.equal(read(root, '.claude/rules/kalfa-docs-always.md'), 'now mine\n');
});

test('kalfa writes only files git ignores', async () => {
	const root = repo('[docs]', '.kalfa/\n');
	await assert.rejects(run(root), /\.claude\/rules\/kalfa-docs-always\.md: git does not ignore it/);
	assert.equal(existsSync(join(root, '.claude')), false);
	assert.equal(existsSync(join(root, '.kalfa')), false);
	await assert.rejects(run(repo('[docs]', '.claude/\n')), /git does not ignore \.kalfa\//);
});

test('a dry run reports and writes nothing', async () => {
	const root = repo('[guardrails]');
	const out = (await run(root, '--dry-run')).out;
	assert.match(out, /write \.claude\/skills\/push-gate\/SKILL\.md[\s\S]*dry run: nothing was written$/);
	assert.equal(existsSync(join(root, '.claude')), false);
	assert.equal(existsSync(join(root, '.kalfa/build.yaml')), false);
});

test('two Modules that write the same file, or an unknown Module, are refused', async () => {
	await assert.rejects(run(repo('[guardrails, clash]')), /the Modules guardrails and clash both write \.claude\/skills\/push-gate\/SKILL\.md/);
	await assert.rejects(run(repo('[nope]')), /unknown Module 'nope'/);
	const bare = gitRepo({ '.gitignore': '.kalfa/\n' });
	mkdirSync(join(bare, 'sub'));
	await assert.rejects(build.run([], captureIo(join(bare, 'sub'))), /no kalfa\.yaml .*; run kalfa init/);
});

// A local upstream with two commits; the Module pins the older one.
function upstream(): { url: string; old: string } {
	const url = gitRepo({ 'skills/grill-me/SKILL.md': '---\nname: grill-me\n---\nAsk one question at a time.\n', 'skills/grill-me/ref.md': 'ref\n' });
	const commit = (message: string) => execFileSync('git', ['-C', url, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qam', message]);
	execFileSync('git', ['-C', url, 'add', '.']);
	commit('one');
	const old = execFileSync('git', ['-C', url, 'rev-parse', 'HEAD']).toString().trim();
	writeFileSync(join(url, 'skills/grill-me/SKILL.md'), 'newer upstream text\n');
	commit('two');
	return { url, old };
}

function pinnedBuild(pin: string, overlay = true) {
	const modules = tempRepo({
		'grill/module.yaml': `schema: 1\ndescription: d\nthird-party:\n  - name: grill-me\n    source: ${pin}\n${overlay ? '    overlay: overlays/grill-me.md\n' : ''}`,
		'grill/overlays/grill-me.md': 'Start each question with a Background section.\n',
	});
	return buildCommand(new Map([['claude', claudeAdapter]]), () => [modules]);
}

test('a pinned third-party skill is installed at its commit with the Overlay appended', async () => {
	const { url, old } = upstream();
	const pinned = pinnedBuild(`${url}\n    path: skills/grill-me\n    commit: ${old}`);
	const root = repo('[grill]');
	const env = { HOME: tempDir() };
	const io = captureIo(root, env);
	assert.equal(await pinned.run([], io), 0);
	assert.match(io.stdout[0]!, new RegExp(`^pin grill-me: ${url} skills/grill-me at ${old.slice(0, 12)}$`));
	assert.equal(
		read(root, '.claude/skills/grill-me/SKILL.md'),
		"---\nname: grill-me\n---\nAsk one question at a time.\n\n<!-- kalfa Overlay from the Module 'grill' -->\n\nStart each question with a Background section.\n",
	);
	assert.equal(read(root, '.claude/skills/grill-me/ref.md'), 'ref\n');
	const state = JSON.parse(read(root, '.kalfa/build.yaml'));
	assert.equal(state.pins['grill-me'].commit, old);
	assert.match(state.pins['grill-me'].sha256, /^[0-9a-f]{64}$/);

	// The cache is used again, and a cache changed on disk is refused.
	const cached = execFileSync('find', [join(env.HOME, '.cache/kalfa/sources'), '-name', 'SKILL.md']).toString().trim();
	writeFileSync(cached, 'tampered\n');
	await assert.rejects(pinned.run([], captureIo(root, env)), /grill-me: the cached copy of .* differs from the hash kalfa recorded/);
});

test('a commit the source does not have is refused and leaves no partial cache', async () => {
	const { url } = upstream();
	const env = { HOME: tempDir() };
	await assert.rejects(pinnedBuild(`${url}\n    path: skills/grill-me\n    commit: ${'b'.repeat(40)}`, false).run([], captureIo(repo('[grill]'), env)), /git fetch/);
	assert.deepEqual(execFileSync('find', [join(env.HOME, '.cache/kalfa/sources'), '-mindepth', '2']).toString(), '');
});
