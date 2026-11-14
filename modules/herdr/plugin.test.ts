import assert from 'node:assert/strict';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { captureIo, tempDir } from '../../test/helpers.ts';
import { herdrPluginStep, PLUGIN_ID, PLUGIN_PANES, pluginRoot } from './plugin.ts';
import { spaceCommand } from './command.ts';

const manifest = readFileSync(join(import.meta.dirname, 'herdr-plugin', 'herdr-plugin.toml'), 'utf8');

/** The `key = value` lines of each `[[table]]` block; a flat string or string array reads as JSON. */
function blocks(table: string): Record<string, unknown>[] {
	return manifest
		.split(/^\[\[/m)
		.slice(1)
		.filter((block) => block.startsWith(`${table}]]`))
		.map((block) => Object.fromEntries(block.split('\n').slice(1).flatMap((line) => {
			const match = /^(\w+) = (.+)$/.exec(line.trim());
			return match ? [[match[1]!, JSON.parse(match[2]!)]] : [];
		})));
}

test('the plugin manifest: each action opens its own popup pane through kalfa space popup, and each pane runs the form', async () => {
	assert.match(manifest, new RegExp(`^id = "${PLUGIN_ID}"$`, 'm'));
	const actions = blocks('actions');
	const panes = blocks('panes');
	assert.deepEqual(actions.map((a) => a.id), [...PLUGIN_PANES]);
	assert.deepEqual(panes.map((p) => p.id), [...PLUGIN_PANES]);
	for (const action of actions) assert.deepEqual(action.command, ['kalfa', 'space', 'popup', action.id]);
	for (const pane of panes) {
		assert.equal(pane.placement, 'popup');
		const command = pane.command as string[];
		assert.deepEqual(command.slice(0, 3), ['kalfa', 'space', 'new']);
		assert.ok(command.includes('--hold-on-error'));
	}
});

test('space popup opens the pane in the folder of the Workspace the action ran from; an unknown pane is refused', async () => {
	const calls: string[][] = [];
	const exec = (args: string[]) => {
		calls.push(args);
		return '{"result":{"type":"ok"}}';
	};
	const env = { HOME: '/home/x', HERDR_PLUGIN_ID: 'kalfa', HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({ workspace_cwd: '/work/shop', focused_pane_cwd: '/work/shop/src' }) };
	const io = captureIo('/plugin-root', env);
	assert.equal(await spaceCommand(new Map(), { exec }).run(['popup', 'new-task'], io), 0);
	assert.deepEqual(calls, [['plugin', 'pane', 'open', '--plugin', 'kalfa', '--entrypoint', 'new-task', '--placement', 'popup', '--cwd', '/work/shop', '--focus']]);

	await spaceCommand(new Map(), { exec }).run(['popup', 'open-space'], captureIo('/here', { HOME: '/home/x' }));
	assert.equal(calls[1]!.at(-2), '/here', 'no plugin context: the current folder');
	await assert.rejects(spaceCommand(new Map(), { exec }).run(['popup', 'board'], io), /no plugin pane 'board'/);
});

/** A folder with an executable `herdr`, for the PATH check. */
function herdrOnPath(): string {
	const dir = tempDir();
	writeFileSync(join(dir, 'herdr'), '#!/bin/sh\nexit 0\n');
	chmodSync(join(dir, 'herdr'), 0o755);
	return dir;
}

/** A fake herdr that answers `plugin list` with `plugins` and records every call. */
function fakeHerdr(plugins: unknown[]) {
	const calls: string[][] = [];
	const exec = (args: string[]) => {
		calls.push(args);
		return JSON.stringify({ id: 'cli:plugin', result: args[1] === 'list' ? { type: 'plugin_list', plugins } : { type: 'ok' } });
	};
	return { exec, calls };
}

const local = (root: string, enabled = true) => ({ plugin_id: 'kalfa', plugin_root: root, enabled, source: { kind: 'local' } });
const LIST = ['plugin', 'list', '--plugin', 'kalfa', '--json'];

test('install links the plugin from the Module folder; a second install changes nothing; a link from another folder is linked again', () => {
	const env = { PATH: herdrOnPath() };
	const root = pluginRoot('/pkg/modules/herdr');
	assert.equal(root, '/pkg/modules/herdr/herdr-plugin');

	const none = fakeHerdr([]);
	assert.match(herdrPluginStep(none.exec).install({ env, moduleDir: '/pkg/modules/herdr', dryRun: false })[0]!, /^plugin: link \/pkg\/modules\/herdr\/herdr-plugin; /);
	assert.deepEqual(none.calls, [LIST, ['plugin', 'link', root]]);

	const same = fakeHerdr([local(root, false)]);
	assert.deepEqual(herdrPluginStep(same.exec).install({ env, moduleDir: '/pkg/modules/herdr', dryRun: false }), [`plugin: linked from ${root} (disabled in Herdr); nothing to change`]);
	assert.deepEqual(same.calls, [LIST], 'no second link, and a plugin the Operator disabled stays disabled');

	const moved = fakeHerdr([local('/old/pkg/modules/herdr/herdr-plugin')]);
	assert.match(herdrPluginStep(moved.exec).install({ env, moduleDir: '/pkg/modules/herdr', dryRun: false })[0]!, /\(was \/old\/pkg\/modules\/herdr\/herdr-plugin\)/);
	assert.deepEqual(moved.calls.at(-1), ['plugin', 'link', root]);

	const dry = fakeHerdr([]);
	herdrPluginStep(dry.exec).install({ env, moduleDir: '/pkg/modules/herdr', dryRun: true });
	assert.deepEqual(dry.calls, [LIST], 'a dry run only lists');
});

test('a kalfa plugin that Herdr installed from elsewhere stays; uninstall unlinks only a local link; no herdr on PATH, nothing runs', () => {
	const env = { PATH: herdrOnPath() };
	const github = fakeHerdr([{ ...local('/x'), source: { kind: 'github' } }]);
	const step = herdrPluginStep(github.exec);
	assert.match(step.install({ env, moduleDir: '/m', dryRun: false })[0]!, /installed from github, not linked by kalfa; left as it is/);
	assert.match(step.uninstall({ env, moduleDir: '/m', dryRun: false })[0]!, /left as it is/);
	assert.deepEqual(github.calls, [LIST, LIST]);

	const linked = fakeHerdr([local('/old/herdr-plugin')]);
	assert.deepEqual(herdrPluginStep(linked.exec).uninstall({ env, moduleDir: '/m', dryRun: false }), ['plugin: unlink kalfa (/old/herdr-plugin)']);
	assert.deepEqual(linked.calls.at(-1), ['plugin', 'unlink', 'kalfa']);
	const none = fakeHerdr([]);
	assert.deepEqual(herdrPluginStep(none.exec).uninstall({ env, moduleDir: '/m', dryRun: false }), ['plugin: not linked; nothing to change']);

	const absent = fakeHerdr([]);
	assert.deepEqual(herdrPluginStep(absent.exec).install({ env: { PATH: tempDir() }, moduleDir: '/m', dryRun: false }), ['plugin: herdr is not on PATH; nothing to do']);
	assert.deepEqual(absent.calls, []);
});
