import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { handledEvents, writeEventTable } from '../src/core/fast-path.ts';
import { privateDir } from '../src/core/private-dir.ts';
import { gitRepo, tempDir } from './helpers.ts';

test('kalfa refuses to write .kalfa/ when git does not ignore it', () => {
	const root = gitRepo();
	assert.throws(() => privateDir(root), { name: 'KalfaError', message: /git does not ignore it/ });
	assert.equal(existsSync(join(root, '.kalfa')), false);
});

test('kalfa creates .kalfa/ when git ignores it', () => {
	const root = gitRepo({ '.gitignore': '.kalfa/\n' });
	assert.equal(privateDir(root), join(root, '.kalfa'));
	assert.equal(existsSync(join(root, '.kalfa')), true);
});

test('outside a git repository the check fails loudly', () => {
	assert.throws(() => privateDir(tempDir()), { name: 'KalfaError', message: /check-ignore failed/ });
});

const a = { name: 'a', handlers: { 'tool.after': () => undefined, 'session.start': () => undefined } };
const b = { name: 'b', handlers: { 'session.start': () => undefined, 'command.before': () => undefined } };

test('the event table lists each handled event once, in Core event order', () => {
	assert.deepEqual(handledEvents([a, b]), ['session.start', 'command.before', 'tool.after']);
	const root = gitRepo({ '.gitignore': '.kalfa/\n' });
	assert.equal(readFileSync(writeEventTable(root, [a, b]), 'utf8'), 'session.start\ncommand.before\ntool.after\n');
});

test('an event keeps its filter only while every Module that handles it has one', () => {
	const push = { name: 'push', handlers: { 'command.before': () => undefined }, filters: { 'command.before': 'git[[:space:]]' } };
	const pr = { name: 'pr', handlers: { 'command.before': () => undefined }, filters: { 'command.before': 'gh[[:space:]]+pr' } };
	const root = gitRepo({ '.gitignore': '.kalfa/\n' });
	assert.equal(readFileSync(writeEventTable(root, [push, pr]), 'utf8'), 'command.before\t(git[[:space:]])|(gh[[:space:]]+pr)\n');
	assert.equal(readFileSync(writeEventTable(root, [push, b]), 'utf8'), 'session.start\ncommand.before\n');
	const sized = { name: 'meter', handlers: { 'command.before': () => undefined }, minContext: { 'command.before': 150_000 } };
	const small = { name: 'small', handlers: { 'command.before': () => undefined }, minContext: { 'command.before': 100_000 } };
	assert.equal(readFileSync(writeEventTable(root, [sized, small]), 'utf8'), 'command.before\t\t100000\n', 'the smallest size, no regex');
	assert.equal(readFileSync(writeEventTable(root, [push, sized]), 'utf8'), 'command.before\t(git[[:space:]])\t150000\n');
});
