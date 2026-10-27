// The meter's decisions, kept apart from the harness and the disk so tests
// reach every branch. Every request sends the whole context again, so a
// request costs more the longer a session runs, and a compact brings it down
// again. After an hour without a request the prompt cache has expired, and the
// next request writes the whole context again. Measured on 2026-10-04: a
// request at 400k tokens cost about five times one at 65k, and stale Monitor
// expiry notices woke a 391k session for $3.13 (API-equivalent).
//   Meter: from the compact point, then from the compact point plus
//   COMPACT_NOW_AFTER and every REPEAT_EVERY tokens after it, the agent is told
//   to remind the Operator to compact (at the end of the current Section
//   first). `/meter off|on|<N>k` sets it for one session; the meter answers
//   it itself, so the prompt never reaches the model.
//   Idle guard: after IDLE_MS without a request, from GUARD_FROM tokens,
//   nothing writes the context again unasked: a typed prompt is held once; a
//   Monitor expiry notice is dropped; a tool result that waited on the
//   Operator ends the turn before the request.
// The prompt and tool names below are Claude Code's; another harness adds its own.
import type { LastRequest } from '../../src/core/usage.ts';
import { COMPACT_NOW_AFTER, GUARD_FROM, IDLE_MS, REPEAT_EVERY } from './budget.ts';
import { rewriteCost } from './pricing.ts';

/** Tools whose run time is the Operator's answer, not work. */
const OPERATOR_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode']);

export interface MeterState {
	/** The meter level the agent was last told about. */
	level: number;
	/** The `at` of the last request when the idle guard last stopped something; the Operator has seen it. */
	guardedFor?: number;
	/** This session's compact point, set by /meter: tokens, or null when the meter is off. Unset is the project's. */
	compactAt?: number | null;
}

/**
 * 0 below the compact point, 1 up to COMPACT_NOW_AFTER past it, then one more
 * per REPEAT_EVERY; null (the meter is off) is always 0.
 */
export function meterLevel(context: number, compactAt: number | null): number {
	if (compactAt === null || context < compactAt) return 0;
	const now = compactAt + COMPACT_NOW_AFTER;
	if (context < now) return 1;
	return 2 + Math.floor((context - now) / REPEAT_EVERY);
}

const k = (tokens: number) => `${Math.round(tokens / 1000)}k`;

export function meterNote(context: number, level: number, compactAt: number): string {
	if (level === 1) {
		return `Context: ${k(context)} tokens (compact point ${k(compactAt)}). Every request re-sends all of it. Finish the current logical section, then: commit, record it with \`kalfa section close\` if a Task is open, stop the monitors and background tasks you started, and remind the operator to run /compact. Do not hand off.`;
	}
	return `Context: ${k(context)} tokens, past the compact point. Remind the operator to run /compact now, before you start new work. Do not hand off.`;
}

/** The /meter prompt: `off`, `on`, `<N>k`, or nothing to show the setting. */
const METER = /^\/meter(?:\s+(\S+))?\s*$/;

/** The setting a /meter prompt asks for; `undefined` when the prompt is not /meter. `on` is the project's compact point. */
export function parseMeter(prompt: string, projectCompactAt: number): { compactAt?: number | null; show?: true; error?: string } | undefined {
	const m = METER.exec(prompt.trim());
	if (!m) return undefined;
	const arg = m[1]?.toLowerCase();
	if (arg === undefined) return { show: true };
	if (arg === 'off') return { compactAt: null };
	if (arg === 'on') return { compactAt: projectCompactAt };
	const n = /^(\d+)k$/.exec(arg);
	if (!n) return { error: `/meter takes off, on, or a compact point such as 300k; not "${m[1]}".` };
	const tokens = Number(n[1]) * 1000;
	if (tokens < GUARD_FROM) return { error: `/meter: the compact point is ${k(GUARD_FROM)} or more; below it the meter does not run.` };
	return { compactAt: tokens };
}

function meterSetting(compactAt: number | null): string {
	if (compactAt === null) return 'off for this session: no /compact reminders. The idle guard stays on';
	return `compact point ${k(compactAt)} for this session, then a reminder every ${k(REPEAT_EVERY)} from ${k(compactAt + COMPACT_NOW_AFTER)}`;
}

function idleText(ms: number): string {
	const minutes = Math.round(ms / 60_000);
	return minutes < 120 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

/** True when every event in a task notification is a Monitor expiry notice. */
export function onlyMonitorExpiry(prompt: string): boolean {
	if (!prompt.trimStart().startsWith('<task-notification>')) return false;
	const events = [...prompt.matchAll(/<event>([\s\S]*?)<\/event>/g)].map((m) => m[1]!.trim());
	return events.length > 0 && events.every((e) => e.startsWith('[Monitor expired after'));
}

export interface GuardInput {
	event: 'prompt' | 'tool';
	prompt?: string;
	tool?: string;
	durationMs?: number;
	last: LastRequest;
	now: number;
	state: MeterState;
	/** The compact point of the project, when /meter did not move it. */
	compactAt: number;
	/** What the Operator can do instead of going on here; read only when the idle guard speaks. */
	fresh: () => string;
}

export type Verdict = { action: 'allow'; note?: string } | { action: 'block'; reason: string; quiet: boolean } | { action: 'stop'; reason: string };

/** How long the Operator kept the session waiting before this event, or 0 when it was work. */
function operatorWait(input: GuardInput): number {
	const sinceRequest = input.now - input.last.at;
	if (input.event === 'prompt') return sinceRequest;
	if (OPERATOR_TOOLS.has(input.tool ?? '')) return sinceRequest;
	// The run time leaves out the approval prompt: what remains is the wait for approval.
	return input.durationMs === undefined ? 0 : sinceRequest - input.durationMs;
}

/** The idle guard's decision, or undefined when it does not apply. */
function idleVerdict(input: GuardInput): Verdict | undefined {
	const { last, state } = input;
	const wait = operatorWait(input);
	if (wait < IDLE_MS || last.context < GUARD_FROM) return undefined;
	const cost = `${k(last.context)} tokens of context again (about $${rewriteCost(last.model, last.context, last.ttl).toFixed(2)}, API-equivalent)`;
	const idle = idleText(wait);
	const prompt = input.prompt?.trimStart() ?? '';

	if (input.event === 'prompt' && onlyMonitorExpiry(prompt)) {
		return { action: 'block', quiet: true, reason: `Dropped a Monitor expiry notice: this session was idle ${idle}, and a reply would write ${cost}. Nothing waits on that watch.` };
	}
	// Notifications, scheduled prompts and slash commands go through: they are work or asked for.
	if (input.event === 'prompt' && (prompt.startsWith('<') || prompt.startsWith('/'))) return undefined;
	if (state.guardedFor === last.at) return undefined;

	if (input.event === 'prompt') {
		return { action: 'block', quiet: false, reason: `Not sent. This session was idle ${idle}, so its prompt cache has expired: the next request writes ${cost}. ${input.fresh()} To go on here anyway, send the prompt again (↑ recalls it).` };
	}
	return { action: 'stop', reason: `Paused before the next request. This session waited ${idle} for you, so its prompt cache has expired: going on writes ${cost}. Your answer is kept. ${input.fresh()} To go on here, type "go on".` };
}

/** The whole decision for one event, and the state to keep. */
export function decide(input: GuardInput): { verdict: Verdict; state: MeterState } {
	const compactPoint = input.state.compactAt === undefined ? input.compactAt : input.state.compactAt;
	const meter = input.event === 'prompt' ? parseMeter(input.prompt ?? '', input.compactAt) : undefined;
	if (meter) {
		// Answered here and never sent: a setting is not worth a request.
		if (meter.error) return { verdict: { action: 'block', quiet: true, reason: meter.error }, state: input.state };
		if (meter.show) return { verdict: { action: 'block', quiet: true, reason: `Context meter: ${meterSetting(compactPoint)}.` }, state: input.state };
		const compactAt = meter.compactAt ?? null;
		// The level the context is at now counts as told: the meter speaks at the next one.
		const state = { ...input.state, compactAt, level: meterLevel(input.last.context, compactAt) };
		return { verdict: { action: 'block', quiet: true, reason: `Context meter: ${meterSetting(compactAt)}. The context is ${k(input.last.context)} tokens.` }, state };
	}
	const idle = idleVerdict(input);
	if (idle) {
		const seen = idle.action === 'block' && idle.quiet ? input.state.guardedFor : input.last.at;
		return { verdict: idle, state: { ...input.state, guardedFor: seen } };
	}
	const level = meterLevel(input.last.context, compactPoint);
	if (level > input.state.level) return { verdict: { action: 'allow', note: meterNote(input.last.context, level, compactPoint ?? input.compactAt) }, state: { ...input.state, level } };
	// After a compact the context shrinks: start counting again.
	return { verdict: { action: 'allow' }, state: { ...input.state, level: Math.min(level, input.state.level) } };
}
