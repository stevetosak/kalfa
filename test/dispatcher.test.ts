import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dispatch } from '../src/core/dispatcher.ts';
import type { CoreEvent } from '../src/core/events.ts';
import { handlerContext, registry } from './fakes.ts';

const command: CoreEvent = { harness: 'fake', cwd: '/repo', name: 'command.before', command: 'git push' };
const toolAfter: CoreEvent = { harness: 'fake', cwd: '/repo', name: 'tool.after', tool: 'Bash' };

const core = { name: 'core', handlers: { 'command.before': () => ({ context: 'from core' }) } };
const docs = { name: 'docs', handlers: { 'command.before': () => ({ context: 'from docs', notice: 'docs notice' }) } };
const guard = { name: 'guardrails', handlers: { 'command.before': () => ({ block: 'no push', context: 'why' }), 'tool.after': () => ({ block: 'ignored' }) } };

test('the Core runs first, then the enabled Modules in the order kalfa.yaml lists them', async () => {
	const result = await dispatch(command, registry(core, docs, guard), handlerContext(['guardrails', 'docs']));
	assert.deepEqual(result, { context: ['from core', 'why', 'from docs'], block: ['no push'], notice: ['docs notice'] });
});

test('a repository without kalfa.yaml runs the Core alone', async () => {
	const result = await dispatch(command, registry(core, docs), handlerContext(undefined));
	assert.deepEqual(result.context, ['from core']);
});

test('a block on an event that cannot block is dropped', async () => {
	const result = await dispatch(toolAfter, registry(core, guard), handlerContext(['guardrails']));
	assert.deepEqual(result.block, []);
});

test('an unknown Module gives a notice and the others still run', async () => {
	const result = await dispatch(command, registry(core, docs), handlerContext(['nope', 'docs']));
	assert.match(result.notice[0] ?? '', /unknown Module\(s\): nope/);
	assert.deepEqual(result.context, ['from core', 'from docs']);
});

const broken = { name: 'broken', handlers: { 'command.before': () => { throw new Error('boom'); } } };

test('a failing handler gives a notice and lets the action pass', async () => {
	const result = await dispatch(command, registry(core, broken, docs), handlerContext(['broken', 'docs']));
	assert.deepEqual(result.block, []);
	assert.match(result.notice[0] ?? '', /Module broken failed on command.before: boom/);
	assert.deepEqual(result.context, ['from core', 'from docs']);
});

test('a failing fail-closed handler stops the action', async () => {
	const strict = { ...broken, failClosed: ['command.before' as const] };
	const result = await dispatch(command, registry(core, strict), handlerContext(['broken']));
	assert.match(result.block[0] ?? '', /boom \(the action is stopped/);
});
