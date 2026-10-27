import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadSettings, settingsPath } from '../src/core/settings.ts';
import { tempDir } from './helpers.ts';

test('the settings live under XDG_CONFIG_HOME when it is set, else under ~/.config', () => {
	assert.equal(settingsPath({ XDG_CONFIG_HOME: '/x', HOME: '/h' }), '/x/kalfa/config.yaml');
	assert.equal(settingsPath({ HOME: '/h' }), '/h/.config/kalfa/config.yaml');
});

test('missing settings give the defaults', () => {
	assert.deepEqual(loadSettings({ HOME: tempDir() }), { schema: 1 });
});

test('a settings file is read and checked', () => {
	const home = tempDir();
	mkdirSync(join(home, '.config', 'kalfa'), { recursive: true });
	writeFileSync(join(home, '.config', 'kalfa', 'config.yaml'), 'schema: 1\ncolour: red\n');
	assert.throws(() => loadSettings({ HOME: home }), { name: 'KalfaError', message: /machine settings is not valid/ });
});
