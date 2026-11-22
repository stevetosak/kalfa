import assert from 'node:assert/strict';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { tempDir } from '../../test/helpers.ts';
import { herdrConfigPath, KEY, keyBindingStep, keyTakenOutside, withKeyBlock, withoutKeyBlock } from './key-binding.ts';
import { machineStepOf } from '../../src/core/machine-step.ts';

const OWN = '[theme]\nname = "dracula"\n\n[[keys.command]]\nkey = "prefix+e"\ntype = "shell"\ncommand = "x"\n';

/** A folder with an executable `herdr`, for the PATH check. */
function herdrOnPath(): string {
	const dir = tempDir();
	writeFileSync(join(dir, 'herdr'), '#!/bin/sh\nexit 0\n');
	chmodSync(join(dir, 'herdr'), 0o755);
	return dir;
}

test('Herdr config path: HERDR_CONFIG_PATH, then XDG_CONFIG_HOME, then ~/.config', () => {
	assert.equal(herdrConfigPath({ HERDR_CONFIG_PATH: '/x/c.toml', XDG_CONFIG_HOME: '/xdg', HOME: '/h' }), '/x/c.toml');
	assert.equal(herdrConfigPath({ XDG_CONFIG_HOME: '/xdg', HOME: '/h' }), '/xdg/herdr/config.toml');
	assert.equal(herdrConfigPath({ HOME: '/h' }), '/h/.config/herdr/config.toml');
});

test('the block: appended once after the Operator\'s text, replaced in place of an old one, removed to the same text', () => {
	const once = withKeyBlock(OWN);
	assert.ok(once.startsWith(`${OWN}\n# >>> kalfa`));
	assert.match(once, /type = "plugin_action"\ncommand = "kalfa\.space"\n/);
	assert.equal(withKeyBlock(once), once, 'a second write changes nothing');
	assert.equal(withoutKeyBlock(once), OWN);
	assert.equal(withoutKeyBlock(OWN), OWN);

	const old = once.replace(`key = "${KEY}"`, 'key = "prefix+u"');
	assert.equal(withKeyBlock(old), once, 'an old block is replaced, not doubled');

	const middle = `${withKeyBlock('[a]\nx = 1\n')}\n[b]\ny = 2\n`;
	assert.equal(withoutKeyBlock(middle), '[a]\nx = 1\n\n[b]\ny = 2\n', 'text after the block stays');
	assert.equal(withoutKeyBlock(withKeyBlock('')), '');
});

test('the key is taken only when the Operator binds it outside kalfa\'s block', () => {
	assert.equal(keyTakenOutside(withKeyBlock(OWN)), false);
	assert.equal(keyTakenOutside(`${OWN}[[keys.command]]\nkey = "${KEY}"\ntype = "shell"\ncommand = "y"\n`), true);
});

test('install writes the block after a passing check; a failing check writes nothing; uninstall removes only the block', () => {
	const dir = tempDir();
	const path = join(dir, 'herdr', 'config.toml');
	const env = { PATH: herdrOnPath(), HERDR_CONFIG_PATH: path };
	const checked: string[] = [];
	const step = keyBindingStep((text) => checked.push(text));

	assert.match(step.install({ env, moduleDir: '/m', dryRun: true })[0]!, /^key: prefix\+shift\+a runs kalfa\.space, written to /);
	assert.equal(existsSync(path), false, 'a dry run writes nothing');

	assert.match(step.install({ env, moduleDir: '/m', dryRun: false })[0]!, /written to/);
	assert.equal(readFileSync(path, 'utf8'), withKeyBlock(''), 'a missing config is made');
	assert.match(step.install({ env, moduleDir: '/m', dryRun: false })[0]!, /nothing to change/);
	assert.equal(checked.length, 2, 'no check when nothing changes');

	writeFileSync(path, OWN);
	const failing = keyBindingStep(() => {
		throw new Error('config: 1 error');
	});
	assert.throws(() => failing.install({ env, moduleDir: '/m', dryRun: false }), /1 error/);
	assert.equal(readFileSync(path, 'utf8'), OWN, 'a failing check leaves the file as it was');

	step.install({ env, moduleDir: '/m', dryRun: false });
	assert.deepEqual(step.uninstall({ env, moduleDir: '/m', dryRun: false }), [`key: removed kalfa's block from ${path}`]);
	assert.equal(readFileSync(path, 'utf8'), OWN);
	assert.match(step.uninstall({ env, moduleDir: '/m', dryRun: false })[0]!, /nothing to change/);
});

test('a key the Operator bound stays; no herdr on PATH, nothing runs', () => {
	const path = join(tempDir(), 'config.toml');
	const taken = `${OWN}[[keys.command]]\nkey = "${KEY}"\ntype = "shell"\ncommand = "y"\n`;
	writeFileSync(path, taken);
	const step = keyBindingStep(() => assert.fail('no check'));
	assert.match(step.install({ env: { PATH: herdrOnPath(), HERDR_CONFIG_PATH: path }, moduleDir: '/m', dryRun: false })[0]!, /already bound .*; left as it is/);
	assert.equal(readFileSync(path, 'utf8'), taken);
	assert.deepEqual(step.install({ env: { PATH: tempDir(), HERDR_CONFIG_PATH: path }, moduleDir: '/m', dryRun: false }), ['key: herdr is not on PATH; nothing to do']);
});

test('a step of several: install in order, uninstall in reverse order', () => {
	const calls: string[] = [];
	const part = (name: string) => ({ install: () => (calls.push(`+${name}`), [name]), uninstall: () => (calls.push(`-${name}`), [name]) });
	const step = machineStepOf(part('plugin'), part('key'));
	const context = { env: {}, moduleDir: '/m', dryRun: false };
	assert.deepEqual(step.install(context), ['plugin', 'key']);
	assert.deepEqual(step.uninstall(context), ['key', 'plugin']);
	assert.deepEqual(calls, ['+plugin', '+key', '-key', '-plugin']);
});
