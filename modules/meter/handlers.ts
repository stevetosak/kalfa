// The meter Module's code: the context meter and the idle guard on every
// prompt and after every tool (guard.ts decides). The shim starts Node for it
// only from GUARD_FROM tokens of context, or for a /meter prompt. In Auto
// mode a Section close past the compact point starts the Reset (reset.ts).
import { z } from 'zod';
import { currentBranch } from '../../src/core/git.ts';
import type { CoreEvent, HandlerResult } from '../../src/core/events.ts';
import { type HandlerContext, type ModuleDefinition, moduleSettings } from '../../src/core/modules.ts';
import type { Project } from '../../src/core/project.ts';
import { readRecord, taskIdOf } from '../../src/core/task-record.ts';
import { inHerdr } from '../herdr/launcher.ts';
import { BASELINE, COMPACT_AT, GUARD_FROM } from './budget.ts';
import { decide, type Verdict } from './guard.ts';
import { paybackRequests } from './pricing.ts';
import { claimPending, logReset, type SpawnWaiter, spawnWaiter } from './reset.ts';
import { readState, stateDir, writeState } from './state.ts';

const settings = z.strictObject({
	/** The compact point in tokens; the meter does not run below GUARD_FROM. */
	'compact-at': z.number().int().min(GUARD_FROM).default(COMPACT_AT),
});

/** What the Operator can do instead of writing the whole context again. */
export function freshStart(project: Project | undefined): string {
	const branch = project && currentBranch(project.root);
	const record = branch ? readRecord(project.root, taskIdOf(branch)) : undefined;
	if (record?.header.status === 'open') return `Task ${record.id} is open: record the Section with \`kalfa section close\`, then /clear shows its brief and \"continue\" loads its Handoff in a fresh, small session.`;
	return '/clear starts a fresh, small session.';
}

function toResult(verdict: Verdict): HandlerResult | undefined {
	switch (verdict.action) {
		case 'block':
			return { block: verdict.reason, quiet: verdict.quiet };
		case 'stop':
			return { stop: verdict.reason };
		case 'allow':
			return verdict.note ? { context: verdict.note } : undefined;
	}
}

const compactPointOf = (context: HandlerContext) => moduleSettings(meterModule, context.project, context.settings)['compact-at'];

function meter(event: CoreEvent, context: HandlerContext, now = Date.now()): HandlerResult | undefined {
	if (event.name !== 'prompt.submit' && event.name !== 'tool.after') return undefined;
	if (event.subagent || !event.sessionId || !event.transcript || !context.usage) return undefined;
	const last = context.usage.lastRequest(event.transcript);
	if (!last) return undefined;
	const dir = stateDir(context.env);
	const before = readState(dir, event.sessionId);
	const { verdict, state } = decide({
		event: event.name === 'prompt.submit' ? 'prompt' : 'tool',
		prompt: event.name === 'prompt.submit' ? event.prompt : undefined,
		tool: event.name === 'tool.after' ? event.tool : undefined,
		durationMs: event.name === 'tool.after' ? event.durationMs : undefined,
		last,
		now,
		state: before,
		compactAt: compactPointOf(context),
		fresh: () => freshStart(context.project),
		herdr: inHerdr(context.env) && !!context.env.HERDR_PANE_ID,
	});
	if (JSON.stringify(state) !== JSON.stringify(before)) writeState(dir, event.sessionId, state);
	return toResult(verdict);
}

export interface ResetDeps {
	spawn: SpawnWaiter;
	now: () => number;
}

/** Auto mode at a Section close: past the compact point, start the Reset, or record the agent's skip. */
export function sectionClose(event: CoreEvent, context: HandlerContext, deps: ResetDeps): HandlerResult | undefined {
	if (event.name !== 'section.close' || !event.sessionId || !event.transcript || !context.usage) return undefined;
	const dir = stateDir(context.env);
	const state = readState(dir, event.sessionId);
	if (!state.auto) return undefined;
	const last = context.usage.lastRequest(event.transcript);
	const compactAt = state.compactAt ?? compactPointOf(context);
	if (!last || last.context < compactAt) return undefined;
	const pane = context.env.HERDR_PANE_ID;
	if (!pane || !inHerdr(context.env)) return { context: 'Auto mode is on, but this session is not in a Herdr pane, so it cannot reset itself. Remind the operator to run /compact.' };
	const payback = paybackRequests(last.model, last.context, BASELINE);
	const job = { pane, session: event.sessionId, repo: context.project?.root ?? event.cwd, task: event.task, model: last.model, context: last.context, ...(payback !== undefined && { payback }) };
	if (event.noReset !== undefined) {
		const { pane: _, session, ...facts } = job;
		logReset(dir, { ...facts, at: deps.now(), kind: 'skip', from: session, estimate: event.noReset });
		return { context: `Auto mode: no Reset; you expect ${event.noReset} more requests${payback === undefined ? '' : ` (a Reset pays back after about ${payback})`}. Go on with the Task.` };
	}
	if (!claimPending(dir, pane, deps.now())) return { context: 'Auto mode: a Reset of this session already waits for your turn to end. End your turn now.' };
	deps.spawn(job, dir);
	return { context: 'Auto mode: this session resets when your turn ends: /clear, then "continue" loads the Task\'s Handoff. Stop the monitors and background tasks you started, then end your turn now; start no new work and ask the Operator nothing.' };
}

export function meterModuleWith(deps: ResetDeps) {
	return {
		name: 'meter',
		settings,
		filters: { 'prompt.submit': '"prompt"[[:space:]]*:[[:space:]]*"[[:space:]]*/meter([[:space:]]|")' },
		minContext: { 'prompt.submit': GUARD_FROM, 'tool.after': GUARD_FROM },
		handlers: {
			'prompt.submit': (event, context) => meter(event, context),
			'tool.after': (event, context) => meter(event, context),
			'section.close': (event, context) => sectionClose(event, context, deps),
		},
	} satisfies ModuleDefinition & { settings: typeof settings };
}

export const meterModule = meterModuleWith({ spawn: spawnWaiter, now: () => Date.now() });
