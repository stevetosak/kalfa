import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { z } from 'zod';
import { isModuleOn, moduleSettings } from '../src/core/modules.ts';
import { loadProject, repoRootOf } from '../src/core/project.ts';
import { tempDir, tempRepo } from './helpers.ts';

test('outside a repository there is no project', () => {
	assert.equal(loadProject(tempDir()), undefined);
});

test('a repository without kalfa.yaml is a project without a file', () => {
	const root = tempRepo();
	assert.deepEqual(loadProject(root), { root, file: undefined });
});

test('the project file is found from a subdirectory, and modules default to none', () => {
	const root = tempRepo({ 'kalfa.yaml': 'schema: 1\n', 'a/b/.keep': '' });
	assert.deepEqual(loadProject(join(root, 'a', 'b')), { root, file: { schema: 1, modules: [], plans: [], settings: {} } });
});

test('a work tree, where .git is a file, is a repository root', () => {
	const root = tempDir();
	writeFileSync(join(root, '.git'), 'gitdir: /elsewhere\n');
	mkdirSync(join(root, 'sub'));
	assert.equal(repoRootOf(join(root, 'sub')), root);
});

test('the nearest repository wins over an outer one', () => {
	const outer = tempRepo({ 'kalfa.yaml': 'schema: 1\nmodules: [docs]\n' });
	const inner = join(outer, 'nested');
	mkdirSync(join(inner, '.git'), { recursive: true });
	assert.deepEqual(loadProject(inner), { root: inner, file: undefined });
});

const refusals: Array<[string, string, RegExp]> = [
	['no schema number', 'modules: []\n', /needs `schema: 1`/],
	['a newer schema', 'schema: 2\n', /newer than this kalfa reads \(1\); upgrade kalfa/],
	['an older schema', 'schema: 0\n', /run `kalfa migrate`/],
	['an unknown key', 'schema: 1\nmodule: [docs]\n', /not valid:[\s\S]*module/],
	['a Module listed twice', 'schema: 1\nmodules: [docs, docs]\n', /listed twice/],
	['a bad Module name', 'schema: 1\nmodules: [Docs]\n', /lower-case/],
	['a Plan glob that leaves the repository', "schema: 1\nplans: ['../other/**/*.md']\n", /stays inside it/],
	['an absolute Plan glob', "schema: 1\nplans: ['/docs/*.md']\n", /stays inside it/],
	['a list instead of a mapping', '- schema\n', /must be a mapping/],
	['broken YAML', 'schema: [1\n', /not valid YAML/],
];

for (const [what, text, message] of refusals) {
	test(`kalfa.yaml with ${what} is refused`, () => {
		const root = tempRepo({ 'kalfa.yaml': text });
		assert.throws(() => loadProject(root), { name: 'KalfaError', message });
	});
}

test('a Module reads its own settings, with defaults, and a wrong value names the Module', () => {
	const schema = z.object({ branches: z.array(z.string()).default(['main']) });
	const module = { name: 'gate', handlers: {}, settings: schema };
	const project = (settings: Record<string, unknown>) => ({ root: '/r', file: { schema: 1 as const, modules: ['gate'], plans: [], settings } });
	assert.deepEqual(moduleSettings(module, project({})), { branches: ['main'] });
	assert.deepEqual(moduleSettings(module, project({ gate: { branches: ['trunk'] } })), { branches: ['trunk'] });
	assert.throws(() => moduleSettings(module, project({ gate: { branches: 'trunk' } })), /settings\.gate \(kalfa\.yaml or the machine settings\): branches: /);
});

test('a Module setting from the machine settings applies, and kalfa.yaml overrides it key by key', () => {
	const schema = z.object({ branches: z.array(z.string()).default(['main']), strict: z.boolean().default(false) });
	const module = { name: 'gate', handlers: {}, settings: schema };
	const project = (settings: Record<string, unknown>) => ({ root: '/r', file: { schema: 1 as const, modules: [], plans: [], settings } });
	const machine = { schema: 1 as const, modules: ['gate'], settings: { gate: { branches: ['trunk'], strict: true } } };
	assert.deepEqual(moduleSettings(module, undefined, machine), { branches: ['trunk'], strict: true });
	assert.deepEqual(moduleSettings(module, project({ gate: { strict: false } }), machine), { branches: ['trunk'], strict: false });
	assert.equal(isModuleOn('gate', project({}), machine), true);
	assert.equal(isModuleOn('gate', project({}), { schema: 1, modules: [] }), false);
});
