import assert from 'node:assert/strict';
import { existsSync, mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { sessionTag, setWake, takeWake, wakePath } from '../src/core/wake.ts';
import { gitRepo } from './helpers.ts';

test("a wake keeps each Module's data under its name, and a newer one replaces only that Module's", () => {
	const root = gitRepo({ '.gitignore': '.kalfa/\n' });
	setWake(root, 'prompt.submit', 's1', 'core', { task: 'a' });
	setWake(root, 'prompt.submit', 's1', 'memory', {});
	setWake(root, 'prompt.submit', 's1', 'core', { task: 'b' });
	assert.deepEqual(takeWake(root, 'prompt.submit', 's1'), { core: { task: 'b' }, memory: {} });
	assert.equal(takeWake(root, 'prompt.submit', 's1'), undefined);
});

test('the marker is per event and session; without a session id it is the event alone', () => {
	const root = gitRepo({ '.gitignore': '.kalfa/\n' });
	assert.equal(wakePath(root, 'prompt.submit', 'a/b c'), join(root, '.kalfa/wake/prompt.submit.a_b_c'));
	assert.equal(sessionTag('0f3e-9A_x'), '0f3e-9A_x');
	setWake(root, 'prompt.submit', undefined, 'core', {});
	assert.ok(existsSync(join(root, '.kalfa/wake/prompt.submit')));
	assert.equal(takeWake(root, 'prompt.submit', 's1'), undefined, 'a session does not take the marker without one');
	assert.deepEqual(takeWake(root, 'prompt.submit', undefined), { core: {} });
});

test('a broken marker, or one in the old format, counts as none and is removed', () => {
	const root = gitRepo({ '.gitignore': '.kalfa/\n' });
	mkdirSync(join(root, '.kalfa/wake'), { recursive: true });
	for (const text of ['not json', '{"session":"s1","data":{"task":"x"}}\n']) {
		writeFileSync(wakePath(root, 'prompt.submit', 's1'), text);
		assert.equal(takeWake(root, 'prompt.submit', 's1'), undefined, text);
		assert.ok(!existsSync(wakePath(root, 'prompt.submit', 's1')));
	}
});

test('setting a wake removes markers older than two days', () => {
	const root = gitRepo({ '.gitignore': '.kalfa/\n' });
	setWake(root, 'prompt.submit', 'old', 'core', {});
	setWake(root, 'prompt.submit', 'recent', 'core', {});
	const days = (n: number) => new Date(Date.now() - n * 86_400_000);
	utimesSync(wakePath(root, 'prompt.submit', 'old'), days(3), days(3));
	utimesSync(wakePath(root, 'prompt.submit', 'recent'), days(1), days(1));
	setWake(root, 'prompt.submit', 'new', 'core', {});
	assert.ok(!existsSync(wakePath(root, 'prompt.submit', 'old')));
	assert.ok(existsSync(wakePath(root, 'prompt.submit', 'recent')));
	assert.ok(existsSync(wakePath(root, 'prompt.submit', 'new')));
});
