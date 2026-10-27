// The Claude transcript reader on hand-made transcript lines: one record per
// request, what woke the model, and the newest request read from the tail.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { lastRequest, parseRequests } from '../src/adapters/claude/transcript.ts';
import { tempDir } from './helpers.ts';

const usage = (read: number, write = 0, ttl: '5m' | '1h' | 'none' = '1h') => ({
	input_tokens: 2,
	output_tokens: 100,
	cache_read_input_tokens: read,
	cache_creation_input_tokens: write,
	...(ttl === 'none' ? {} : { cache_creation: { ephemeral_5m_input_tokens: ttl === '5m' ? write : 0, ephemeral_1h_input_tokens: ttl === '1h' ? write : 0 } }),
});
const assistant = (requestId: string, at: string, u: object, content: unknown[] = [], extra = {}) =>
	JSON.stringify({ type: 'assistant', requestId, timestamp: at, message: { model: 'claude-opus-5-5', usage: u, content }, ...extra });
const user = (content: unknown, extra = {}) => JSON.stringify({ type: 'user', message: { role: 'user', content }, ...extra });
const toolResult = [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }];

function file(lines: string[]): string {
	const path = join(tempDir(), 't.jsonl');
	writeFileSync(path, lines.join('\n'));
	return path;
}

test('one record per request: repeated lines fold, their tool calls join, the cache writes split by lifetime', () => {
	const [record, ...rest] = parseRequests([
		user('build the meter'),
		assistant('r1', '2026-10-27T10:00:00Z', usage(50_000, 10_000), [{ type: 'text', text: 'hi' }]),
		assistant('r1', '2026-10-27T10:00:00Z', usage(50_000, 10_000), [{ type: 'tool_use', name: 'Skill', input: { skill: 'meter' } }]),
		assistant('r1', '2026-10-27T10:00:00Z', usage(50_000, 10_000), [{ type: 'tool_use', name: 'Bash', input: {} }]),
	]);
	assert.equal(rest.length, 0);
	assert.deepEqual([record!.context, record!.tools, record!.trigger, record!.prompt], [60_002, ['Skill:meter', 'Bash'], 'operator', 'build the meter']);
	assert.deepEqual(record!.usage.cacheWrite, { '5m': 0, '1h': 10_000 });
	const [old] = parseRequests([assistant('r1', '2026-10-27T10:00:00Z', usage(0, 500, 'none'))]);
	assert.deepEqual(old!.usage.cacheWrite, { '5m': 500, '1h': 0 }, 'no split: the five-minute lifetime');
});

test('triggers follow the user line before each request; side-chain, empty and broken lines are left out', () => {
	const lines = [
		assistant('r1', '2026-10-27T10:00:00Z', usage(1000)),
		user(toolResult),
		assistant('r2', '2026-10-27T10:00:05Z', usage(2000)),
		user('<task-notification>\n<event>tick</event>\n</task-notification>'),
		assistant('r3', '2026-10-27T10:01:00Z', usage(3000)),
		user([{ type: 'text', text: 'Base directory for this skill' }], { isMeta: true }),
		assistant('r4', '2026-10-27T10:02:00Z', usage(4000)),
		assistant('side', '2026-10-27T10:02:30Z', usage(9000), [], { isSidechain: true }),
		assistant('synthetic', '2026-10-27T10:03:00Z', { input_tokens: 0, output_tokens: 0 }),
		'{"type":"assistant", broken',
	];
	assert.deepEqual(
		parseRequests(lines).map((r) => [r.id, r.trigger]),
		[
			['r1', 'start'],
			['r2', 'tool-result'],
			['r3', 'notification'],
			['r4', 'meta'],
		],
	);
	assert.deepEqual(
		parseRequests(lines, { subagent: true }).map((r) => r.id),
		['r1', 'r2', 'r3', 'r4', 'side'],
		"a subagent's own transcript is all side chain",
	);
});

test('lastRequest takes the newest request and the newest cache lifetime', () => {
	const last = lastRequest(file([assistant('r1', '2026-10-27T10:00:00Z', usage(10_000, 5_000, '5m')), user(toolResult), assistant('r2', '2026-10-27T11:00:00Z', usage(20_000))]))!;
	assert.deepEqual([last.id, last.at, last.ttl], ['r2', Date.parse('2026-10-27T11:00:00Z'), '5m'], 'r2 wrote nothing; r1 wrote with five minutes');
});

test('lastRequest looks further back when a huge last line fills the tail, and finds nothing in a transcript without a request', () => {
	const huge = file([assistant('r1', '2026-10-27T10:00:00Z', usage(30_000, 1_000)), user([{ type: 'tool_result', content: 'x'.repeat(600 * 1024) }])]);
	assert.deepEqual([lastRequest(huge)?.id, lastRequest(huge)?.ttl], ['r1', '1h']);
	assert.equal(lastRequest(file([user('hello')])), undefined);
	assert.equal(lastRequest(join(tempDir(), 'none.jsonl')), undefined);
});
