// Auto mode: the /meter switch, the notes, the Section close that starts or
// skips a Reset, the waiter's steps against a fake Herdr, and the Resets part
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
import { COMPACT_AT } from './budget.ts';
import { decide, type GuardInput } from './guard.ts';
import { type ResetDeps, sectionClose } from './handlers.ts';
import { paybackRequests } from './pricing.ts';
import { resets } from './report.ts';
import { claimPending, readResets, type ResetJob, runReset } from './reset.ts';
import { readState, stateDir, writeState } from './state.ts';

const NOW = Date.parse('2026-11-13T12:00:00Z');
const usage = { input: 0, output: 0, cacheWrite: { '5m': 0, '1h': 0 }, cacheRead: 0 };
const last = (context: number): LastRequest => ({ id: 'r', at: NOW - 60_000, model: 'claude-opus-5-5', usage, context, trigger: 'tool-result', tools: [], ttl: '1h' });
const input = (over: Partial<GuardInput>): GuardInput => ({ event: 'prompt', prompt: 'x', last: last(120_000), now: NOW, state: { level: 0 }, compactAt: COMPACT_AT, fresh: () => '', ...over });

test('/meter auto works only in Herdr, keeps the compact point, and off or on end it', () => {
	const outside = decide(input({ prompt: '/meter auto' }));
	assert.match((outside.verdict as { reason: string }).reason, /not in one/);
	assert.equal(outside.state.auto, undefined);
	const on = decide(input({ prompt: '/meter auto', herdr: true, state: { level: 1, compactAt: 200_000 } }));
	assert.deepEqual(on.state, { level: 0, compactAt: 200_000, auto: true });
	assert.equal(decide(input({ prompt: '/meter 300k', state: on.state })).state.auto, true, 'a new compact point keeps it');
	assert.equal(decide(input({ prompt: '/meter on', state: on.state })).state.auto, undefined);
	assert.equal(decide(input({ prompt: '/meter off', state: on.state })).state.auto, undefined);
});

test('in Auto mode the meter tells the agent to close a Section, with the payback estimate; past COMPACT_NOW_AFTER at once', () => {
	const note = (context: number, level: number) => {
		const { verdict } = decide(input({ event: 'tool', tool: 'Bash', durationMs: 1, last: last(context), state: { level, auto: true } }));
		return verdict.action === 'allow' ? (verdict.note ?? '') : '';
	};
	assert.match(note(160_000, 0), /Auto mode[\s\S]*kalfa section close[\s\S]*pays back after about \d+ requests[\s\S]*--no-reset/);
	assert.doesNotMatch(note(160_000, 0), /remind the operator to run/);
	assert.match(note(210_000, 1), /Close a Section now, even in the middle of a step/);
});

test('the payback estimate: the start written once against the context read less on each request', () => {
	// Opus 5.5: 65k written at $8/M = $0.52; 95k less read at $0.20/M = $0.019 a request.
	assert.equal(paybackRequests('claude-opus-5-5', 160_000, 65_000), 28);
	assert.equal(paybackRequests('claude-opus-5-5', 60_000, 65_000), undefined);
});

/** A transcript with one request of `context` tokens. */
function transcript(context: number): string {
	const path = join(tempDir(), 's.jsonl');
	const request = { type: 'assistant', requestId: 'r1', timestamp: new Date().toISOString(), message: { model: 'claude-opus-5-5', usage: { input_tokens: 10, cache_read_input_tokens: context - 10, output_tokens: 1 } } };
	writeFileSync(path, `${JSON.stringify(request)}\n`);
	return path;
}

test('a Section close in Auto mode past the compact point starts one waiter, records a skip, and does nothing otherwise', () => {
	const env = { HOME: tempDir(), HERDR_ENV: '1', HERDR_PANE_ID: 'w1:p1', PATH: '' };
	const context = { ...handlerContext(['meter']), env, usage: claudeAdapter.usage };
	const jobs: ResetJob[] = [];
	const deps: ResetDeps = { spawn: (job) => jobs.push(job), now: () => NOW };
	const event = (path: string, extra = {}): CoreEvent => ({ harness: 'claude', cwd: '/repo', name: 'section.close', task: 't', record: '/r', section: { title: 's', parts: new Map() }, sessionId: 's1', transcript: path, ...extra });
	const dir = stateDir(env);
	const big = transcript(160_000);

	assert.equal(sectionClose(event(big), context, deps), undefined, 'not in Auto mode');
	writeState(dir, 's1', { level: 1, auto: true });
	assert.equal(sectionClose(event(transcript(120_000)), context, deps), undefined, 'below the compact point');
	// inHerdr needs the herdr program on PATH; without it the session cannot reset.
	assert.match(sectionClose(event(big), context, deps)?.context ?? '', /not in a Herdr pane/);

	const bin = tempDir();
	writeFileSync(join(bin, 'herdr'), '#!/bin/sh\n', { mode: 0o755 });
	const herdr = { ...context, env: { ...env, PATH: bin } };
	assert.match(sectionClose(event(big), herdr, deps)?.context ?? '', /resets when your turn ends/);
	assert.deepEqual(jobs, [{ pane: 'w1:p1', session: 's1', repo: '/repo', task: 't', model: 'claude-opus-5-5', context: 160_000, payback: 28 }]);
	assert.match(sectionClose(event(big), herdr, deps)?.context ?? '', /already waits/);
	assert.equal(jobs.length, 1, 'one waiter per pane');

	assert.match(sectionClose(event(big, { noReset: 4 }), herdr, deps)?.context ?? '', /no Reset; you expect 4 more requests/);
	assert.deepEqual(readResets(dir).map((e) => [e.kind, e.estimate, e.from]), [['skip', 4, 's1']]);
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
	const job: ResetJob = { pane: 'w1:p1', session: 'old', repo: '/repo', task: 't', model: 'claude-opus-5-5', context: 160_000, payback: 28 };
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

test('the Resets part measures cost and saving from the new session, and a skip against what followed', () => {
	const request = (at: number, context: number, write = 0) => ({ id: `r${at}`, at, model: 'claude-opus-5-5', usage: { ...usage, cacheWrite: { '5m': 0, '1h': write } }, context, trigger: 'operator' as const, tools: [] });
	const sessions: SessionUsage[] = [
		{ project: 'p', id: 'new', requests: [request(NOW + 1, 70_000, 70_000), ...Array.from({ length: 39 }, (_, i) => request(NOW + 2 + i, 75_000))] },
		{ project: 'p', id: 'kept', requests: [request(NOW - 1, 170_000), request(NOW + 5, 171_000), request(NOW + 6, 172_000)] },
	];
	const base = { repo: '/repo', task: 't', model: 'claude-opus-5-5', context: 160_000, payback: 28 };
	const lines = resets(
		[
			{ ...base, at: NOW, kind: 'reset', from: 'old', to: 'new' },
			{ ...base, at: NOW, kind: 'skip', from: 'kept', estimate: 4 },
			{ ...base, at: NOW + 5, kind: 'skip', from: 'kept', estimate: 1 },
			{ ...base, at: NOW, kind: 'failed', from: 'x', reason: '/clear showed no new session id' },
		],
		sessions,
	);
	assert.equal(lines[0], 'Resets (Auto mode): 1 done, 2 skipped, 1 failed.');
	// $0.56 written; 90k less read a request is $0.018, over 40 requests $0.72.
	assert.match(lines[1]!, /160k→70k {2}cost \$0\.56 {2}saved \$0\.72 over 40 requests {2}paid back after 32, estimate 28/);
	// The session's next close at NOW + 5 ends the first skip's count.
	assert.match(lines[2]!, /skipped: 4 requests expected, 1 followed/);
	assert.match(lines[3]!, /skipped: 1 requests expected, 1 followed/);
	assert.match(lines[4]!, /failed: \/clear showed no new session id/);
	assert.deepEqual(resets([], sessions), []);
});
