import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { hookCommand } from '../src/cli/commands/hook.ts';
import { fakeAdapter, registry } from './fakes.ts';
import { captureIo, gitRepo, tempDir } from './helpers.ts';

const core = { name: 'core', handlers: { 'session.start': () => ({ context: 'core report' }) } };
const guard = { name: 'guardrails', handlers: { 'command.before': () => ({ block: 'no push' }) } };
const hook = hookCommand(new Map([['fake', fakeAdapter]]), registry(core, guard));

async function run(args: string[], payload: unknown, cwd = tempDir()) {
	const io = captureIo(cwd, { HOME: tempDir() }, typeof payload === 'string' ? payload : JSON.stringify(payload));
	const code = await hook.run(args, io);
	return { code, stdout: io.stdout, stderr: io.stderr.join('\n'), result: io.stdout[0] ? JSON.parse(io.stdout[0]) : undefined };
}

test('own errors exit 1, never 2', async () => {
	assert.equal((await run(['nope', 'session.start'], {})).code, 1);
	assert.match((await run(['fake', 'session.begin'], {})).stderr, /not a Core event/);
	assert.match((await run(['fake', 'session.start'], 'not json')).stderr, /payload is not JSON/);
	assert.match((await run(['fake'], {})).stderr, /usage: kalfa hook/);
});

test('a payload that is not the event exits 0 with no output', async () => {
	assert.deepEqual(await run(['fake', 'command.before'], { skip: true, cwd: '/' }), { code: 0, stdout: [], stderr: '', result: undefined });
});

test("the Adapter renders the merged result and sets the exit code", async () => {
	const root = gitRepo({ 'kalfa.yaml': 'schema: 1\nmodules: [guardrails]\n' });
	const out = await run(['fake', 'command.before'], { cwd: root, command: 'git push' });
	assert.equal(out.code, 2);
	assert.deepEqual(out.result.block, ['no push']);
});

test('a broken kalfa.yaml gives a notice and the Core still runs', async () => {
	const root = gitRepo({ 'kalfa.yaml': 'schema: 7\n' });
	const out = await run(['fake', 'session.start'], { cwd: root });
	assert.deepEqual(out.result.context, ['core report']);
	assert.match(out.result.notice[0], /schema 7 is newer/);
});

test('session.start writes the event table when .kalfa/ is ignored', async () => {
	const root = gitRepo({ 'kalfa.yaml': 'schema: 1\nmodules: [guardrails]\n', '.gitignore': '.kalfa/\n' });
	const out = await run(['fake', 'session.start'], { cwd: root });
	assert.deepEqual(out.result.notice, []);
	assert.equal(readFileSync(join(root, '.kalfa', 'events'), 'utf8'), 'session.start\ncommand.before\n');
});

test('session.start does not write the table into a .kalfa/ git would commit', async () => {
	const root = gitRepo({ 'kalfa.yaml': 'schema: 1\n' });
	const out = await run(['fake', 'session.start'], { cwd: root });
	assert.match(out.result.notice[0], /git does not ignore it/);
	assert.equal(existsSync(join(root, '.kalfa')), false);
});
