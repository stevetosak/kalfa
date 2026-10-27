import assert from 'node:assert/strict';
import { test } from 'node:test';
import { main, version } from '../src/cli/main.ts';
import { captureIo, tempDir, tempRepo } from './helpers.ts';

test('--version prints the package version', async () => {
	const io = captureIo(tempDir());
	assert.equal(await main(['--version'], io), 0);
	assert.deepEqual(io.stdout, [version]);
});

test('no command prints the usage and exits 2', async () => {
	const io = captureIo(tempDir());
	assert.equal(await main([], io), 2);
	assert.match(io.stderr.join('\n'), /Usage: kalfa <command>/);
});

test('an unknown command exits 2', async () => {
	const io = captureIo(tempDir());
	assert.equal(await main(['frobnicate'], io), 2);
	assert.match(io.stderr.join('\n'), /unknown command 'frobnicate'/);
});

test('an inherited object key is not a command', async () => {
	assert.equal(await main(['toString'], captureIo(tempDir())), 2);
});

test('an unknown option exits 2 with the command usage', async () => {
	const io = captureIo(tempDir());
	assert.equal(await main(['doctor', '--bogus'], io), 2);
	assert.match(io.stderr.join('\n'), /Usage: kalfa doctor/);
});

test('doctor outside a repository', async () => {
	const io = captureIo(tempDir());
	assert.equal(await main(['doctor'], io), 0);
	assert.match(io.stdout.join('\n'), /not found, defaults[\s\S]*project: none/);
});

test('doctor names the enabled Modules', async () => {
	const io = captureIo(tempRepo({ 'kalfa.yaml': 'schema: 1\nmodules: [docs, guardrails]\n' }));
	assert.equal(await main(['doctor'], io), 0);
	assert.match(io.stdout.join('\n'), /Modules: docs, guardrails/);
});

test('doctor reports a broken project file and exits 1', async () => {
	const io = captureIo(tempRepo({ 'kalfa.yaml': 'schema: 9\n' }));
	assert.equal(await main(['doctor'], io), 1);
	assert.match(io.stderr.join('\n'), /^kalfa doctor: .*schema 9 is newer/);
});
