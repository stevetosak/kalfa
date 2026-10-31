import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadModuleSource, moduleFolders, parseRule } from '../src/core/module-source.ts';
import { moduleDirs, moduleDirsOrOwn } from '../src/core/module-dirs.ts';
import { modulesRoot, packageRoot } from '../src/core/package-root.ts';
import { coreModule } from '../src/modules/core.ts';
import { withFolderModules } from '../src/modules/index.ts';
import { tempRepo } from './helpers.ts';

const PIN = 'a'.repeat(40);

test('a Module folder: skills and rules found from the folder, the rest from module.yaml', () => {
	const root = tempRepo({
		'guardrails/module.yaml': `schema: 1\ndescription: Hard rules.\nneeds:\n  - capability: command-block\n    without: the push gate only warns\ncommands:\n  ask: ['terraform *']\nthird-party:\n  - name: grill-me\n    source: https://example.com/skills.git\n    path: skills/grill-me\n    commit: ${PIN}\n    overlay: overlays/grill-me.md\n`,
		'guardrails/overlays/grill-me.md': 'Start each question with a Background section.\n',
		'guardrails/skills/push-gate/SKILL.md': '---\nname: push-gate\n---\nbody\n',
		'guardrails/skills/push-gate/scripts/check.sh': 'echo\n',
		'guardrails/rules/infra.md': "---\npaths: ['core/**/*.yaml']\n---\nPin every image.\n",
		'guardrails/rules/always.md': 'Ask before every push.\n',
	});
	const source = loadModuleSource([root], 'guardrails');
	assert.deepEqual(source.skills.map((s) => s.name), ['push-gate']);
	assert.deepEqual(source.rules, [
		{ name: 'always', body: 'Ask before every push.\n' },
		{ name: 'infra', paths: ['core/**/*.yaml'], body: 'Pin every image.\n' },
	]);
	assert.deepEqual(source.manifest.commands, { allow: [], ask: ['terraform *'], deny: [] });
	assert.equal(source.manifest.needs[0]!.capability, 'command-block');
	assert.equal(source.manifest['third-party'][0]!.commit, PIN);
});

const refusals: Array<[string, Record<string, string>, RegExp]> = [
	['an unknown Module', {}, /unknown Module 'm'/],
	['an unknown Capability', { 'm/module.yaml': 'schema: 1\ndescription: d\nneeds: [{capability: telepathy, without: x}]\n' }, /capability/],
	['a short commit pin', { 'm/module.yaml': 'schema: 1\ndescription: d\nthird-party: [{name: s, source: u, path: p, commit: abc123}]\n' }, /full 40-character commit/],
	['a missing overlay', { 'm/module.yaml': `schema: 1\ndescription: d\nthird-party: [{name: s, source: u, path: p, commit: ${PIN}, overlay: o.md}]\n` }, /overlay o\.md does not exist/],
	['a skill without SKILL.md', { 'm/module.yaml': 'schema: 1\ndescription: d\n', 'm/skills/s/README.md': '' }, /needs SKILL\.md/],
	['a skill name used twice', { 'm/module.yaml': `schema: 1\ndescription: d\nthird-party: [{name: s, source: u, path: p, commit: ${PIN}}]\n`, 'm/skills/s/SKILL.md': '' }, /'s' is used twice/],
	['a rule with other frontmatter', { 'm/module.yaml': 'schema: 1\ndescription: d\n', 'm/rules/r.md': '---\napplyTo: x\n---\n' }, /holds only `paths:`/],
];

for (const [what, files, message] of refusals) {
	test(`a Module with ${what} is refused`, () => {
		assert.throws(() => loadModuleSource([tempRepo(files)], 'm'), { name: 'KalfaError', message });
	});
}

test('a rule without frontmatter loads everywhere', () => {
	assert.deepEqual(parseRule('Text.\n', 'r', 'r.md'), { name: 'r', body: 'Text.\n' });
});

test('the package root is found from the source', () => {
	assert.equal(packageRoot(), process.cwd());
});

test('a Module folder without handlers is a known Module; a folder without module.yaml is not', () => {
	const root = tempRepo({ 'rules-only/module.yaml': 'schema: 1\ndescription: d\n', 'stray/notes.md': 'x\n' });
	const registry = withFolderModules(new Map([['core', coreModule]]), [root]);
	assert.deepEqual([...registry.keys()], ['core', 'rules-only']);
	assert.deepEqual(registry.get('rules-only')?.handlers, {});
	assert.equal(withFolderModules(new Map([['core', coreModule]]), [`${root}/missing`]).size, 1);
});

test('KALFA_MODULES_DIR moves the Module folders', () => {
	assert.equal(modulesRoot({ KALFA_MODULES_DIR: '/elsewhere' }), '/elsewhere');
	assert.equal(modulesRoot({}), `${packageRoot()}/modules`);
});

test('a second Module folder adds its Modules; a name in two folders is refused', () => {
	const own = tempRepo({ 'docs/module.yaml': 'schema: 1\ndescription: d\n' });
	const extra = tempRepo({ 'platform/module.yaml': 'schema: 1\ndescription: p\n', 'platform/rules/r.md': 'Text.\n' });
	assert.deepEqual(moduleFolders([own, extra]), ['docs', 'platform']);
	assert.equal(loadModuleSource([own, extra], 'platform').dir, `${extra}/platform`);
	assert.throws(() => loadModuleSource([own, extra], 'nope'), { name: 'KalfaError', message: new RegExp(`unknown Module 'nope' .*${extra}`) });
	const clash = tempRepo({ 'docs/module.yaml': 'schema: 1\ndescription: d\n' });
	assert.throws(() => loadModuleSource([own, clash], 'docs'), { name: 'KalfaError', message: /more than one Module folder/ });
	assert.equal(loadModuleSource([own, own], 'docs').dir, `${own}/docs`);
});

test('module-dirs follows the package folder; ~/ is the home; bad settings fall back only on the hook path', () => {
	const home = tempRepo({ '.config/kalfa/config.yaml': 'schema: 1\nmodules: []\nmodule-dirs: [~/infra/kalfa/modules, /opt/modules]\n' });
	const env = { HOME: home, KALFA_MODULES_DIR: '/own' };
	assert.deepEqual(moduleDirs(env), ['/own', `${home}/infra/kalfa/modules`, '/opt/modules']);
	assert.deepEqual(moduleDirs({ HOME: tempRepo({}), KALFA_MODULES_DIR: '/own' }), ['/own']);

	const relative = tempRepo({ '.config/kalfa/config.yaml': 'schema: 1\nmodules: []\nmodule-dirs: [modules]\n' });
	assert.throws(() => moduleDirs({ HOME: relative }), { name: 'KalfaError', message: /absolute path or starts with ~\// });
	assert.deepEqual(moduleDirsOrOwn({ HOME: relative, KALFA_MODULES_DIR: '/own' }), ['/own']);
});

test('every Module folder this kalfa ships loads', () => {
	const names = moduleFolders([modulesRoot({})]);
	assert.deepEqual(names, ['docs', 'guardrails', 'herdr', 'infra', 'memory', 'meter']);
	for (const name of names) assert.equal(loadModuleSource([modulesRoot({})], name).name, name);
});

// Claude Code gives a path-scoped rule only its first 40,000 characters (200K context window).
const SCOPED_RULE_LIMIT = 40_000;

test('every shipped path-scoped rule fits the smallest per-file limit', () => {
	for (const name of moduleFolders([modulesRoot({})])) {
		for (const rule of loadModuleSource([modulesRoot({})], name).rules) {
			if (rule.paths) assert.ok(rule.body.length < SCOPED_RULE_LIMIT, `${name}/${rule.name}: ${rule.body.length} characters`);
		}
	}
});
