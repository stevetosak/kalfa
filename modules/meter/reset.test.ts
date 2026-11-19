// Auto mode: the setting and the /meter switch, the note at a large context,
// the session start line, the Section close that starts or keeps a Reset, the waiter's steps against a fake Herdr, and the Resets part
// of the usage report.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { claudeAdapter } from '../../src/adapters/claude/adapter.ts';
import type { CoreEvent } from '../../src/core/events.ts';
import type { LastRequest, SessionUsage } from '../../src/core/usage.ts';
import { handlerContext } from '../../test/fakes.ts';
import { tempDir } from '../../test/helpers.ts';
import { COMPACT_AT, LARGE_AT, LARGE_EVERY, RESET_FROM } from './budget.ts';
import { decide, type GuardInput } from './guard.ts';
import { meterModule, type ResetDeps, sectionClose } from './handlers.ts';
import { resets } from './report.ts';
import { claimPending, readResets, type ResetJob, runReset } from './reset.ts';
import { readState, stateDir, writeState } from './state.ts';

const NOW = Date.parse('2026-11-13T12:00:00Z');
const usage = { input: 0, output: 0, cacheWrite: { '5m': 0, '1h': 0 }, cacheRead: 0 };
const last = (context: number): LastRequest => ({ id: 'r', at: NOW - 60_000, model: 'claude-opus-5-5', usage, context, trigger: 'tool-result', tools: [], ttl: '1h' });
const input = (over: Partial<GuardInput>): GuardInput => ({ event: 'prompt', prompt: 'x', last: last(120_000), now: NOW, state: { level: 0 }, compactAt: COMPACT_AT, fresh: () => '', ...over });

test('/meter auto works only in Herdr, keeps the compact point, and off or on end it, also over the setting', () => {
	const outside = decide(input({ prompt: '/meter auto' }));
	assert.match((outside.verdict as { reason: string }).reason, /not in one/);
	assert.equal(outside.state.auto, undefined);
	const on = decide(input({ prompt: '/meter auto', herdr: true, state: { level: 1, compactAt: 200_000 } }));
	assert.deepEqual(on.state, { level: 0, compactAt: 200_000, auto: true });
	assert.equal(decide(input({ prompt: '/meter 300k', state: on.state })).state.auto, true, 'a new compact point keeps it');
	const off = decide(input({ prompt: '/meter on', herdr: true, autoDefault: true, state: on.state }));
	assert.equal(off.state.auto, false, 'stored, so the setting does not turn it on again');
	assert.match((off.verdict as { reason: string }).reason, /compact point 150k/);
	assert.equal(decide(input({ prompt: '/meter off', state: on.state })).state.auto, false);
	const shown = decide(input({ prompt: '/meter', herdr: true, autoDefault: true }));
	assert.match((shown.verdict as { reason: string }).reason, /Auto mode for this session: from 100k every Section close resets it[\s\S]*--keep/);
	assert.match((decide(input({ prompt: '/meter', autoDefault: true })).verdict as { reason: string }).reason, /compact point 150k/, 'the setting does nothing outside Herdr');
});

test('in Auto mode no token count asks for a Section: from LARGE_AT the agent gets a note, again every LARGE_EVERY', () => {
	const note = (context: number, level: number, over: Partial<GuardInput> = { herdr: true, autoDefault: true }) => {
		const { verdict } = decide(input({ event: 'tool', tool: 'Bash', durationMs: 1, last: last(context), state: { level }, ...over }));
		return verdict.action === 'allow' ? (verdict.note ?? '') : '';
	};
	assert.equal(note(COMPACT_AT + 60_000, 0), '', 'past the old compact point: nothing');
	assert.match(note(LARGE_AT, 0), /300k tokens \(Auto mode\)[\s\S]*fine while the work needs its details[\s\S]*kalfa section close[\s\S]*--keep/);
	assert.doesNotMatch(note(LARGE_AT, 0), /remind the operator to run/);
	assert.equal(note(LARGE_AT + 10_000, 1), '', 'told once per level');
	assert.match(note(LARGE_AT + LARGE_EVERY, 1), /400k tokens/);
	assert.match(note(COMPACT_AT + 1, 0, { herdr: false, autoDefault: true }), /remind the operator to run \/compact/, 'outside Herdr the meter reminds');
	assert.match(note(COMPACT_AT + 1, 0, { herdr: true, autoDefault: true, state: { level: 0, auto: false } }), /remind the operator/, '/meter on ended it');
});

test('at session start in a Herdr pane the auto setting tells the agent the rule; /meter off and other places hear nothing', async () => {
	const bin = tempDir();
	writeFileSync(join(bin, 'herdr'), '#!/bin/sh\n', { mode: 0o755 });
	const env = { HOME: tempDir(), HERDR_ENV: '1', HERDR_PANE_ID: 'w1:p1', PATH: bin };
	const base = handlerContext(['meter']);
	const withAuto = { ...base, env, settings: { ...base.settings, settings: { meter: { auto: true } } } };
	const start = (context: typeof base, sessionId = 's1') =>
		meterModule.handlers['session.start']({ harness: 'claude', cwd: '/repo', name: 'session.start', source: 'startup', sessionId }, context);
	assert.match((await start(withAuto))?.context ?? '', /^Auto mode \(kalfa meter\): close a Section[\s\S]*from 100k[\s\S]*--keep/);
	assert.equal(await start({ ...base, env }), undefined, 'the setting is off');
	assert.equal(await start({ ...withAuto, env: { ...env, HERDR_PANE_ID: '' } }), undefined, 'not in a pane');
	writeState(stateDir(env), 's2', { level: 0, auto: false });
	assert.equal(await start(withAuto, 's2'), undefined, '/meter on or off ended it');
});

/** A transcript with one request of `context` tokens. */
function transcript(context: number): string {
	const path = join(tempDir(), 's.jsonl');
	const request = { type: 'assistant', requestId: 'r1', timestamp: new Date().toISOString(), message: { model: 'claude-opus-5-5', usage: { input_tokens: 10, cache_read_input_tokens: context - 10, output_tokens: 1 } } };
	writeFileSync(path, `${JSON.stringify(request)}\n`);
	return path;
}

test('a Section close in Auto mode from RESET_FROM starts one waiter, records a keep, and does nothing otherwise', () => {
	const env = { HOME: tempDir(), HERDR_ENV: '1', HERDR_PANE_ID: 'w1:p1', PATH: '' };
	const context = { ...handlerContext(['meter']), env, usage: claudeAdapter.usage };
	const jobs: ResetJob[] = [];
	const deps: ResetDeps = { spawn: (job) => jobs.push(job), now: () => NOW };
	const event = (path: string, extra = {}): CoreEvent => ({ harness: 'claude', cwd: '/repo', name: 'section.close', task: 't', record: '/r', section: { title: 's', parts: new Map() }, sessionId: 's1', transcript: path, ...extra });
	const dir = stateDir(env);
	const big = transcript(RESET_FROM + 10_000);

	assert.equal(sectionClose(event(big), context, deps), undefined, 'not in Auto mode');
	writeState(dir, 's1', { level: 0, auto: true });
	// inHerdr needs the herdr program on PATH; without it the session cannot reset.
	assert.match(sectionClose(event(big), context, deps)?.context ?? '', /not in a Herdr pane/);

	const bin = tempDir();
	writeFileSync(join(bin, 'herdr'), '#!/bin/sh\n', { mode: 0o755 });
	const herdr = { ...context, env: { ...env, PATH: bin } };
	assert.equal(sectionClose(event(transcript(RESET_FROM - 1)), herdr, deps), undefined, 'below RESET_FROM');
	assert.match(sectionClose(event(big), herdr, deps)?.context ?? '', /resets when your turn ends/);
	assert.deepEqual(jobs, [{ pane: 'w1:p1', session: 's1', repo: '/repo', task: 't', model: 'claude-opus-5-5', context: RESET_FROM + 10_000 }]);
	assert.match(sectionClose(event(big), herdr, deps)?.context ?? '', /already waits/);
	assert.equal(jobs.length, 1, 'one waiter per pane');

	assert.match(sectionClose(event(big, { keep: true }), herdr, deps)?.context ?? '', /no Reset \(--keep\)/);
	assert.deepEqual(readResets(dir).map((e) => [e.kind, e.from]), [['keep', 's1']]);

	// The auto setting alone: a session /meter did not touch resets too; outside a pane the setting is silent.
	const withAuto = { ...herdr, settings: { ...herdr.settings, settings: { meter: { auto: true } } } };
	assert.match(sectionClose(event(big, { sessionId: 's3' }), { ...withAuto, env: { ...withAuto.env, HERDR_PANE_ID: 'w1:p3' } }, deps)?.context ?? '', /resets when your turn ends/);
	assert.equal(sectionClose(event(big, { sessionId: 's4' }), { ...withAuto, env: { ...withAuto.env, HERDR_PANE_ID: '' } }, deps), undefined);
});

/** A fake Herdr: the agent's session id changes when /clear is typed. */
function fakeHerdr(sessions: string[]) {
	const calls: string[] = [];
	let current = 0;
	const exec = (args: string[]) => {
		calls.push(args.slice(0, 2).concat(args[1] === 'prompt' ? [args[3]!] : []).join(' '));
		if (args[1] === 'get') return JSON.stringify({ result: { agent: { agent_session: { value: sessions[current] } } } });
		if (args[1] === 'prompt' && args[3] === '/clear') {
			current = Math.min(current + 1, sessions.length - 1);
			throw new Error('agent_prompt_stalled');
		}
		return '{}';
	};
	return { exec, calls };
}

test('the waiter waits for the turn, clears, proves the new session id, carries Auto mode, and continues', () => {
	const dir = tempDir();
	const job: ResetJob = { pane: 'w1:p1', session: 'old', repo: '/repo', task: 't', model: 'claude-opus-5-5', context: 160_000 };
	writeState(dir, 'old', { level: 2, auto: true, compactAt: 150_000 });
	claimPending(dir, job.pane, NOW);
	const herdr = fakeHerdr(['old', 'new']);
	let now = NOW;
	const entry = runReset(job, { exec: herdr.exec, dir, now: () => now, sleep: (ms) => (now += ms) });
	assert.equal(entry.kind, 'reset');
	assert.equal(entry.to, 'new');
	assert.deepEqual(herdr.calls, ['agent wait', 'agent get', 'agent prompt /clear', 'agent get', 'agent prompt continue']);
	assert.deepEqual(readState(dir, 'new'), { auto: true, compactAt: 150_000, level: 0 });
	assert.deepEqual(readResets(dir).map((e) => e.kind), ['reset']);
	assert.ok(claimPending(dir, job.pane, NOW), 'the claim is released');

	const stuck = runReset(job, { exec: fakeHerdr(['old']).exec, dir, now: () => now, sleep: (ms) => (now += ms) });
	assert.match(stuck.reason ?? '', /no new session id/);
	const moved = fakeHerdr(['other']);
	assert.match(runReset(job, { exec: moved.exec, dir, now: () => now, sleep: () => {} }).reason ?? '', /another session/);
	assert.ok(!moved.calls.some((c) => c.startsWith('agent prompt')), 'nothing typed into another session');
});

test('the Resets part measures the net from the cost per request before and after, beside the estimate, and a keep against what followed', () => {
	const request = (at: number, context: number, write = 0) => ({ id: `r${at}`, at, model: 'claude-opus-5-5', usage: { ...usage, cacheWrite: { '5m': 0, '1h': write }, cacheRead: context - write }, context, trigger: 'operator' as const, tools: [] });
	const sessions: SessionUsage[] = [
		{ project: 'p', id: 'new', requests: [request(NOW + 1, 70_000, 70_000), ...Array.from({ length: 39 }, (_, i) => request(NOW + 2 + i, 75_000))] },
		{ project: 'p', id: 'old', requests: Array.from({ length: 25 }, (_, i) => request(NOW - 25 + i, 160_000)) },
		{ project: 'p', id: 'kept', requests: [request(NOW - 1, 170_000), request(NOW + 5, 171_000), request(NOW + 6, 172_000)] },
	];
	const base = { repo: '/repo', task: 't', model: 'claude-opus-5-5', context: 160_000, payback: 28 };
	const lines = resets(
		[
			{ ...base, at: NOW, kind: 'reset', from: 'old', to: 'new' },
			{ ...base, at: NOW, kind: 'skip', from: 'kept', estimate: 4 },
			{ ...base, at: NOW + 5, kind: 'keep', from: 'kept' },
			{ ...base, at: NOW, kind: 'failed', from: 'x', reason: '/clear showed no new session id' },
		],
		sessions,
	);
	assert.equal(lines[0], 'Resets (Auto mode): 1 done, 2 kept, 1 failed.');
	// Before: 160k read at $0.20/M = $0.032 a request. After: $0.56 written once, then 75k read = $0.015;
	// the average of 40 is $0.0287, so the net is $1.28 - $1.145 = $0.135. The estimate: 90k less read x 40 - $0.56 = $0.16.
	assert.match(lines[1]!, /160k→70k {2}40 requests after {2}per request \$0\.03 → \$0\.03 {2}measured net \$0\.14 {2}estimate net \$0\.16/);
	// The session's next close at NOW + 5 ends the first keep's count.
	assert.match(lines[2]!, /kept: 4 requests expected, 1 followed/);
	assert.match(lines[3]!, /kept: 1 followed/);
	assert.match(lines[4]!, /failed: \/clear showed no new session id/);
	assert.equal(lines[5], '  measured net of 1 Resets: $0.14');
	assert.deepEqual(resets([], sessions), []);
});
