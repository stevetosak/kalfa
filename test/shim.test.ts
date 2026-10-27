// The fast-path shim decides without Node. KALFA_NODE points at a stub that
// records the call, so the test sees whether Node would have started.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { tempDir, tempRepo } from './helpers.ts';

const bin = tempDir();
const shim = join(bin, 'kalfa-hook');
writeFileSync(shim, readFileSync('src/cli/kalfa-hook.sh', 'utf8').replace('@CORE_EVENTS@', 'session.start'));
const stub = join(bin, 'node-stub');
writeFileSync(stub, '#!/usr/bin/env bash\necho "ran $*"; cat\n');
chmodSync(stub, 0o755);

function shimRuns(cwd: string, event: string): boolean {
	const out = execFileSync('bash', [shim, 'fake', event], { cwd, input: '{"x":1}', env: { ...process.env, KALFA_NODE: stub } }).toString();
	if (out) assert.equal(out, `ran ${join(bin, 'kalfa.mjs')} hook fake ${event}\n{"x":1}`);
	return out !== '';
}

test('a Core event always starts Node', () => {
	assert.equal(shimRuns(tempDir(), 'session.start'), true);
});

test('Node starts once, also for a Core event where the event table would start it too', () => {
	const root = tempRepo({ 'kalfa.yaml': 'schema: 1\n' });
	assert.equal(shimRuns(root, 'session.start'), true);
});

test('outside a repository, or without kalfa.yaml, a Module event does not', () => {
	assert.equal(shimRuns(tempDir(), 'command.before'), false);
	assert.equal(shimRuns(tempRepo(), 'command.before'), false);
});

test('with kalfa.yaml and no event table, Node starts', () => {
	const root = tempRepo({ 'kalfa.yaml': 'schema: 1\n', 'src/.keep': '' });
	assert.equal(shimRuns(join(root, 'src'), 'command.before'), true);
});

test('the event table decides, unless kalfa.yaml is newer', () => {
	const root = tempRepo({ 'kalfa.yaml': 'schema: 1\n' });
	mkdirSync(join(root, '.kalfa'));
	writeFileSync(join(root, '.kalfa', 'events'), 'command.before\n');
	utimesSync(join(root, 'kalfa.yaml'), new Date(2000, 0), new Date(2000, 0));
	assert.equal(shimRuns(root, 'command.before'), true);
	assert.equal(shimRuns(root, 'tool.after'), false);
	utimesSync(join(root, 'kalfa.yaml'), new Date(), new Date(Date.now() + 60_000));
	assert.equal(shimRuns(root, 'tool.after'), true);
});

test('a filtered event starts Node only when the payload matches the filter', () => {
	const root = tempRepo({ 'kalfa.yaml': 'schema: 1\n' });
	mkdirSync(join(root, '.kalfa'));
	writeFileSync(join(root, '.kalfa', 'events'), 'session.start\ncommand.before\t(git[[:space:]]+push)|(gh[[:space:]]+pr)\n');
	utimesSync(join(root, 'kalfa.yaml'), new Date(2000, 0), new Date(2000, 0));
	const runs = (input: string) => execFileSync('bash', [shim, 'fake', 'command.before'], { cwd: root, input, env: { ...process.env, KALFA_NODE: stub } }).toString() !== '';
	assert.equal(runs('{"command":"git push origin x"}'), true);
	assert.equal(runs('{"command":"gh  pr create"}'), true);
	assert.equal(runs('{"command":"git status"}'), false);
	assert.equal(shimRuns(root, 'tool.after'), false, 'an event the table does not list');
});

test('an event with a context size starts Node from that size, as the Adapter probe reads it', () => {
	const root = tempRepo({ 'kalfa.yaml': 'schema: 1\n' });
	mkdirSync(join(root, '.kalfa'));
	writeFileSync(join(root, '.kalfa', 'events'), 'prompt.submit\t"/meter"\t100000\ntool.after\t\t100000\n');
	utimesSync(join(root, 'kalfa.yaml'), new Date(2000, 0), new Date(2000, 0));
	mkdirSync(join(bin, 'adapters', 'fake'), { recursive: true });
	writeFileSync(join(bin, 'adapters', 'fake', 'context-probe'), '#!/usr/bin/env bash\ngrep -o "[0-9]*" | head -n 1\n');
	chmodSync(join(bin, 'adapters', 'fake', 'context-probe'), 0o755);
	const runs = (event: string, input: string) => execFileSync('bash', [shim, 'fake', event], { cwd: root, input, env: { ...process.env, KALFA_NODE: stub } }).toString() !== '';
	assert.equal(runs('tool.after', '{"size":99999}'), false);
	assert.equal(runs('tool.after', '{"size":100000}'), true);
	assert.equal(runs('tool.after', '{"no":"size"}'), true, 'the probe cannot tell: Node decides');
	assert.equal(runs('prompt.submit', '{"prompt":"/meter","size":5}'), true, 'the filter alone is enough');
	assert.equal(runs('prompt.submit', '{"prompt":"hi","size":5}'), false);
});
