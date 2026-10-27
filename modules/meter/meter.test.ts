// The meter: the levels, the idle guard, the handler, the prices, the usage
// report, the Claude context probe and the status-line tap.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { claudeAdapter } from '../../src/adapters/claude/adapter.ts';
import { loadSessions } from '../../src/adapters/claude/transcript.ts';
import { checkLimits } from '../../src/core/usage-limits.ts';
import type { LastRequest } from '../../src/core/usage.ts';
import { handlerContext } from '../../test/fakes.ts';
import { writeRecord } from '../../src/core/task-record.ts';
import { gitRepo, tempDir } from '../../test/helpers.ts';
import { COMPACT_AT, GUARD_FROM, IDLE_MS, REPEAT_EVERY } from './budget.ts';
import { decide, type GuardInput, meterLevel, onlyMonitorExpiry, parseMeter } from './guard.ts';
import { freshStart, meterModule } from './handlers.ts';
import { carryCost, requestCost, rewriteCost } from './pricing.ts';
import { cacheWrites, report, wakeups } from './report.ts';

const NOW = Date.parse('2026-10-04T13:30:00Z');
const usage = { input: 0, output: 0, cacheWrite: { '5m': 0, '1h': 0 }, cacheRead: 0 };
const last = (context: number, minutesAgo: number): LastRequest => ({ id: 'r', at: NOW - minutesAgo * 60_000, model: 'claude-opus-5-5', usage, context, trigger: 'tool-result', tools: [], ttl: '1h' });
const input = (over: Partial<GuardInput>): GuardInput => ({
	event: 'prompt',
	prompt: 'what next?',
	last: last(300_000, 140),
	now: NOW,
	state: { level: 0 },
	compactAt: COMPACT_AT,
	fresh: () => 'Task t is open.',
	...over,
});
const note = (input: GuardInput) => {
	const { verdict } = decide(input);
	return verdict.action === 'allow' ? verdict.note : undefined;
};
const EXPIRY = '<task-notification>\n<summary>Monitor event: "build"</summary>\n<event>[Monitor expired after 30m with 3 events delivered. Re-arm it if you still need the watch.]</event>\n</task-notification>';
const tool = { event: 'tool' as const, tool: 'Bash', durationMs: 50 };

test('meter levels: none below the compact point, then one per REPEAT_EVERY from 50k past it; none when off', () => {
	assert.equal(meterLevel(COMPACT_AT - 1, COMPACT_AT), 0);
	assert.equal(meterLevel(COMPACT_AT, COMPACT_AT), 1);
	assert.equal(meterLevel(COMPACT_AT + 50_000, COMPACT_AT), 2);
	assert.equal(meterLevel(COMPACT_AT + 50_000 + REPEAT_EVERY, COMPACT_AT), 3);
	assert.equal(meterLevel(900_000, null), 0);
});

test('the meter speaks once per level, and counts again after the context shrank', () => {
	const at160 = input({ ...tool, last: last(160_000, 1) });
	const first = decide(at160);
	assert.match(note(at160) ?? '', /160k tokens \(compact point 150k\)[\s\S]*kalfa section close[\s\S]*remind the operator to run \/compact[\s\S]*Do not hand off/);
	assert.equal(note({ ...at160, state: first.state }), undefined);
	const past = decide(input({ ...tool, last: last(210_000, 1), state: first.state }));
	assert.match(past.verdict.action === 'allow' ? (past.verdict.note ?? '') : '', /past the compact point[\s\S]*\/compact now/);
	assert.equal(decide(input({ ...tool, last: last(70_000, 1), state: past.state })).state.level, 0);
	assert.match(note(input({ ...tool, last: last(260_000, 1), compactAt: 250_000 })) ?? '', /compact point 250k/, 'the project moves the compact point');
});

test('/meter sets the compact point for one session and is never sent', () => {
	const meter = (prompt: string, state: GuardInput['state'] = { level: 0 }, context = 154_000) => decide(input({ prompt, last: last(context, 1), state }));
	const off = meter('/meter off');
	assert.deepEqual(off.verdict, { action: 'block', quiet: true, reason: 'Context meter: off for this session: no /compact reminders. The idle guard stays on. The context is 154k tokens.' });
	assert.equal(note(input({ ...tool, last: last(400_000, 1), state: off.state })), undefined);

	const raised = meter('/meter 300k');
	assert.equal(raised.state.compactAt, 300_000);
	assert.equal(note(input({ ...tool, last: last(250_000, 1), state: raised.state })), undefined);
	assert.match(note(input({ ...tool, last: last(310_000, 1), state: raised.state })) ?? '', /310k tokens \(compact point 300k\)/);

	const on = meter('/meter on', { level: 0, compactAt: null }, 160_000);
	assert.deepEqual([on.state.compactAt, on.state.level], [COMPACT_AT, 1], 'turned on past the compact point, the current level counts as told');
	assert.match(meter('/meter', raised.state).verdict.action === 'block' ? (meter('/meter', raised.state).verdict as { reason: string }).reason : '', /compact point 300k/);
	assert.match(parseMeter('/meter lots', COMPACT_AT)?.error ?? '', /off, on, or a compact point/);
	assert.match(parseMeter('/meter 80k', COMPACT_AT)?.error ?? '', /100k or more/);
	assert.equal(parseMeter('/metering', COMPACT_AT), undefined);
	assert.equal(parseMeter('please /meter off', COMPACT_AT), undefined);
});

test('a typed prompt into a cold, large session is held once; sending it again goes through', () => {
	const held = decide(input({}));
	assert.match(held.verdict.action === 'block' ? held.verdict.reason : '', /idle 2 h 20 min[\s\S]*300k tokens[\s\S]*\$2\.40[\s\S]*Task t is open\./);
	assert.equal(held.verdict.action === 'block' && held.verdict.quiet, false);
	assert.equal(decide(input({ state: held.state })).verdict.action, 'allow');
});

test('notifications, slash commands and a scheduled loop go through; a Monitor expiry is dropped quietly', () => {
	for (const prompt of ['<task-notification>\n<event>build failed</event>\n</task-notification>', '/close-task section', '<<autonomous-loop-dynamic>>']) {
		assert.equal(decide(input({ prompt })).verdict.action, 'allow', prompt);
	}
	const dropped = decide(input({ prompt: EXPIRY }));
	assert.equal(dropped.verdict.action === 'block' && dropped.verdict.quiet, true);
	assert.equal(dropped.state.guardedFor, undefined, 'the Operator has seen nothing yet');
	assert.equal(onlyMonitorExpiry(EXPIRY.replace('</task-notification>', '<event>Error</event>\n</task-notification>')), false);
	assert.equal(onlyMonitorExpiry('[Monitor expired after 30m]'), false);
});

test('the guard is quiet within the hour and below GUARD_FROM', () => {
	assert.equal(decide(input({ last: last(300_000, 59) })).verdict.action, 'allow');
	assert.equal(decide(input({ last: last(GUARD_FROM - 1, 300) })).verdict.action, 'allow');
});

test('a late answer or approval ends the turn; a long tool run does not', () => {
	const late = { event: 'tool' as const, last: last(300_000, 90) };
	assert.equal(decide(input({ ...late, tool: 'AskUserQuestion', durationMs: 90 * 60_000 })).verdict.action, 'stop');
	assert.equal(decide(input({ ...late, tool: 'Bash', durationMs: 2_000 })).verdict.action, 'stop', 'approved 90 min late');
	assert.equal(decide(input({ ...late, tool: 'Agent', durationMs: 89 * 60_000 })).verdict.action, 'allow', 'the time was work');
	assert.equal(decide(input({ ...late, tool: 'Agent' })).verdict.action, 'allow', 'no duration: cannot tell');
	const stopped = decide(input({ ...late, tool: 'AskUserQuestion', durationMs: IDLE_MS }));
	assert.equal(decide(input({ last: late.last, state: stopped.state, prompt: 'go on' })).verdict.action, 'allow', 'typing after the pause goes on');
});

/** A transcript with one request of `context` tokens, `minutesAgo` minutes ago. */
function transcript(context: number, minutesAgo = 1, lines: object[] = []): string {
	const path = join(tempDir(), 's.jsonl');
	const at = new Date(Date.now() - minutesAgo * 60_000).toISOString();
	const request = { type: 'assistant', requestId: 'r1', timestamp: at, message: { model: 'claude-opus-5-5', usage: { input_tokens: 10, cache_read_input_tokens: context - 10, output_tokens: 1 } } };
	writeFileSync(path, [...lines, request].map((l) => JSON.stringify(l)).join('\n') + '\n');
	return path;
}

test('the handler reads the session through the Adapter, keeps its state in the cache, and skips subagents', async () => {
	const env = { HOME: tempDir() };
	const context = { ...handlerContext(['meter']), env, usage: claudeAdapter.usage };
	const event = (path: string, extra = {}) => ({ harness: 'claude', cwd: '/', name: 'tool.after' as const, tool: 'Bash', durationMs: 10, sessionId: 's1', transcript: path, ...extra });
	const path = transcript(160_000);
	assert.match((await meterModule.handlers['tool.after'](event(path), context))?.context ?? '', /160k tokens/);
	assert.equal(await meterModule.handlers['tool.after'](event(path), context), undefined, 'said once');
	assert.ok(existsSync(join(env.HOME, '.cache', 'kalfa', 'meter', 's1.json')));
	assert.equal(await meterModule.handlers['tool.after'](event(path, { sessionId: 's2', subagent: true }), context), undefined);
	const stopped = await meterModule.handlers['tool.after'](event(transcript(300_000, 90), { sessionId: 's3', tool: 'AskUserQuestion', durationMs: 90 * 60_000 }), context);
	assert.match(stopped?.stop ?? '', /Paused before the next request[\s\S]*\/clear starts a fresh, small session/);
	const project = { ...context, project: { root: '/r', file: { schema: 1 as const, modules: ['meter'], plans: [], settings: { meter: { 'compact-at': 50_000 } } } } };
	await assert.rejects(Promise.resolve().then(() => meterModule.handlers['tool.after'](event(path, { sessionId: 's4' }), project)), /settings\.meter: compact-at/);
});

test('API-equivalent prices: Opus 5.5 with an hour-long write; an unknown model costs nothing', () => {
	const u = { input: 2, output: 100, cacheWrite: { '5m': 0, '1h': 1_000_000 }, cacheRead: 1_000_000 };
	const cost = requestCost('claude-opus-5-5', u);
	assert.deepEqual([cost.read, cost.write, cost.output], [0.2, 8, 100 * 20e-6]);
	assert.equal(requestCost('<synthetic>', u).total, 0);
	assert.equal(rewriteCost('claude-sonnet-5-5', 1_000_000, '5m'), 2.5);
	assert.equal(carryCost('claude-haiku-4-5-20251001', 1_000_000), 0.1);
});

test('the idle guard offers the open Task of the branch, else a fresh session', () => {
	const root = gitRepo({ '.gitignore': '.kalfa/\n' });
	execFileSync('git', ['-C', root, 'checkout', '-q', '-b', 'feat/x']);
	const project = { root, file: undefined };
	assert.equal(freshStart(project), '/clear starts a fresh, small session.');
	writeRecord(root, { id: 'feat-x', header: { schema: 1, goal: 'g', status: 'open', started: '2026-10-27' }, sections: [] });
	assert.match(freshStart(project), /^Task feat-x is open: record the Section with `kalfa section close`, then \/clear shows its Handoff/);
	assert.equal(freshStart(undefined), '/clear starts a fresh, small session.');
});

test('the usage report sums the sessions of the projects folder', () => {
	const root = tempDir();
	mkdirSync(join(root, '-home-op-Projects-Active-kalfa', 's1', 'subagents'), { recursive: true });
	const at = '2026-10-27T10:00:00Z';
	const line = (id: string, input: number) => JSON.stringify({ type: 'assistant', requestId: id, timestamp: at, message: { model: 'claude-opus-5-5', usage: { input_tokens: input, output_tokens: 1000 } } });
	writeFileSync(join(root, '-home-op-Projects-Active-kalfa', 's1.jsonl'), `${JSON.stringify({ type: 'user', message: { content: 'hi' } })}\n${line('a', 1_000_000)}\n`);
	writeFileSync(join(root, '-home-op-Projects-Active-kalfa', 's1', 'subagents', 'x.jsonl'), `${line('b', 1_000_000)}\n`);
	const sessions = loadSessions(root, Date.parse('2026-10-27'));
	assert.deepEqual(sessions.map((s) => [s.project, s.agent ?? 'main']), [['kalfa', 'main'], ['kalfa', 'subagent']]);
	const text = report(sessions);
	assert.match(text, /^Total \$8\.04 API-equivalent, 2 requests, 1 main sessions\./);
	assert.match(text, /main sessions\s+\$4\.02\s+50%/);
	assert.equal(loadSessions(root, Date.parse('2026-10-28')).length, 0);
	assert.equal(report([]), 'No requests in this period.');
});

test('the usage report names what woke the model, tells session starts from rewrites, and names a subagent by its meta file', () => {
	const root = tempDir();
	const project = join(root, '-home-op-Projects-Active-demo');
	mkdirSync(join(project, 'abc12345', 'subagents'), { recursive: true });
	const request = (id: string, at: string, read: number, write: number, extra = {}) =>
		JSON.stringify({ type: 'assistant', requestId: id, timestamp: at, message: { model: 'claude-opus-5-5', usage: { input_tokens: 1, output_tokens: 10, cache_read_input_tokens: read, cache_creation_input_tokens: write, cache_creation: { ephemeral_1h_input_tokens: write } } }, ...extra });
	const user = (content: unknown) => JSON.stringify({ type: 'user', message: { content } });
	writeFileSync(
		join(project, 'abc12345.jsonl'),
		[
			user('Go on with the Task'),
			request('r1', '2026-10-27T10:00:00Z', 0, 60_000),
			user([{ type: 'tool_result', content: 'ok' }]),
			request('r2', '2026-10-27T10:00:10Z', 60_000, 1_000),
			user('<task-notification>\n<event>[Monitor expired after 30m]</event>\n</task-notification>'),
			request('r3', '2026-10-27T12:30:00Z', 0, 61_000),
		].join('\n'),
	);
	writeFileSync(join(project, 'abc12345', 'subagents', 'agent-x.jsonl'), request('s1', '2026-10-27T10:00:05Z', 50_000, 2_000, { isSidechain: true }));
	writeFileSync(join(project, 'abc12345', 'subagents', 'agent-x.meta.json'), JSON.stringify({ name: 'reviewer' }));
	const sessions = loadSessions(root);
	assert.deepEqual(sessions.map((s) => [s.project, s.agent, s.requests.length]), [['demo', undefined, 3], ['demo', 'reviewer', 1]]);
	assert.match(wakeups(sessions).join('\n'), /task notification/);
	const writes = cacheWrites(sessions).join('\n');
	assert.match(writes, /Session starts: 1 wrote/);
	assert.match(writes, /Rewrites after a pause past the cache lifetime: 1[\s\S]*after 150 min/);
	assert.match(report(sessions), /Main sessions, most expensive first[\s\S]*Go on with the Task/);
});

const hasJq = (() => {
	try {
		execFileSync('jq', ['--version'], { stdio: 'ignore' });
		return true;
	} catch {
		return false;
	}
})();
const adapterScript = (name: string) => resolve(import.meta.dirname, '../../src/adapters/claude', name);

test('the Claude context probe prints the last request, 0 for a subagent, nothing it cannot read', { skip: !hasJq && 'jq is not installed' }, () => {
	const probe = (payload: object) => execFileSync('bash', [adapterScript('context-probe.sh')], { input: JSON.stringify(payload), encoding: 'utf8' }).trim();
	const path = transcript(123_456);
	assert.equal(probe({ transcript_path: path }), '123456');
	assert.equal(probe({ transcript_path: path, agent_id: 'a1' }), '0');
	assert.equal(probe({ transcript_path: '/nonexistent' }), '0');
	const empty = join(tempDir(), 'e.jsonl');
	writeFileSync(empty, '{"type":"user"}\n');
	assert.equal(probe({ transcript_path: empty }), '', 'no request yet: Node decides');
});

test('the status-line tap saves the limits where the Core reads them and hands the input on', { skip: !hasJq && 'jq is not installed' }, () => {
	const env = { ...process.env, HOME: tempDir(), XDG_CACHE_HOME: '' };
	const status = JSON.stringify({ model: 'x', rate_limits: { five_hour: { used_percentage: 91, resets_at: 1 }, seven_day: { used_percentage: 3 } } });
	const out = execFileSync('bash', [adapterScript('status-tap.sh'), 'cat'], { input: status, encoding: 'utf8', env });
	assert.equal(out, status);
	const file = join(env.HOME, '.cache', 'kalfa', 'usage-limits.json');
	assert.match(JSON.stringify(checkLimits(file)), /five_hour at 91%/);
	assert.ok(JSON.parse(readFileSync(file, 'utf8')).savedAt > 0);
});
