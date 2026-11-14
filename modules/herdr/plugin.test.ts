import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { captureIo } from '../../test/helpers.ts';
import { PLUGIN_ID, PLUGIN_PANES } from './plugin.ts';
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
