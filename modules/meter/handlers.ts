// The meter Module's code: the context meter and the idle guard on every
// prompt and after every tool (guard.ts decides). The shim starts Node for it
// only from GUARD_FROM tokens of context, or for a /meter prompt. In Auto
// mode a Section close from RESET_FROM starts the Reset (reset.ts), unless
// the agent passes --keep; at session start the agent is told the rule.
import { z } from 'zod';
import { currentBranch } from '../../src/core/git.ts';
import type { CoreEvent, HandlerResult } from '../../src/core/events.ts';
import { type HandlerContext, type ModuleDefinition, moduleSettings } from '../../src/core/modules.ts';
import type { Project } from '../../src/core/project.ts';
import { readRecord, taskIdOf } from '../../src/core/task-record.ts';
import { inHerdr } from '../herdr/launcher.ts';
import { COMPACT_AT, GUARD_FROM, RESET_FROM } from './budget.ts';
import { AUTO_RULE, autoOn, decide, type Verdict } from './guard.ts';
import { claimPending, logReset, type SpawnWaiter, spawnWaiter } from './reset.ts';
import { readState, stateDir, writeState } from './state.ts';

const settings = z.strictObject({
	/** The compact point in tokens; the meter does not run below GUARD_FROM. */
	'compact-at': z.number().int().min(GUARD_FROM).default(COMPACT_AT),
	/** Auto mode in every session inside a Herdr pane, unless /meter on|off ends it for one session. */
	auto: z.boolean().default(false),
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

const settingsOf = (context: Pick<HandlerContext, 'project' | 'settings'>) => moduleSettings(meterModule, context.project, context.settings);
const compactPointOf = (context: HandlerContext) => settingsOf(context)['compact-at'];
const inHerdrPane = (env: NodeJS.ProcessEnv) => inHerdr(env) && !!env.HERDR_PANE_ID;

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
		herdr: inHerdrPane(context.env),
		autoDefault: settingsOf(context).auto,
	});
	if (JSON.stringify(state) !== JSON.stringify(before)) writeState(dir, event.sessionId, state);
	return toResult(verdict);
}

export interface ResetDeps {
	spawn: SpawnWaiter;
	now: () => number;
}

/** Auto mode at a Section close: from RESET_FROM, start the Reset, or record the agent's --keep. */
export function sectionClose(event: CoreEvent, context: HandlerContext, deps: ResetDeps): HandlerResult | undefined {
	if (event.name !== 'section.close' || !event.sessionId || !event.transcript || !context.usage) return undefined;
	const dir = stateDir(context.env);
	const state = readState(dir, event.sessionId);
	const pane = context.env.HERDR_PANE_ID;
	if (!pane || !inHerdrPane(context.env)) {
		// The `auto` setting does nothing outside Herdr; a session switched on by hand hears why nothing happens.
		return state.auto ? { context: 'Auto mode is on, but this session is not in a Herdr pane, so it cannot reset itself. Remind the operator to run /compact.' } : undefined;
	}
	if (!autoOn(state, settingsOf(context).auto, true)) return undefined;
	const last = context.usage.lastRequest(event.transcript);
	if (!last || last.context < RESET_FROM) return undefined;
	const job = { pane, session: event.sessionId, repo: context.project?.root ?? event.cwd, task: event.task, model: last.model, context: last.context };
	if (event.keep) {
		const { pane: _, session, ...facts } = job;
		logReset(dir, { ...facts, at: deps.now(), kind: 'keep', from: session });
		return { context: 'Auto mode: no Reset (--keep); this session keeps its context. Go on with the Task, and close the next Section when the work moves on.' };
	}
	if (!claimPending(dir, pane, deps.now())) return { context: 'Auto mode: a Reset of this session already waits for your turn to end. End your turn now.' };
	deps.spawn(job, dir);
	return { context: 'Auto mode: this session resets when your turn ends: /clear, then "continue" loads the Task\'s Handoff. Stop the monitors and background tasks you started, then end your turn now; start no new work and ask the Operator nothing.' };
}

/** Auto mode at session start: the agent learns the rule once; a session that /meter switched off hears nothing. */
function sessionStart(event: CoreEvent, context: HandlerContext): HandlerResult | undefined {
	if (event.name !== 'session.start' || event.subagent || !inHerdrPane(context.env)) return undefined;
	const state = event.sessionId ? readState(stateDir(context.env), event.sessionId) : { level: 0 };
	if (!autoOn(state, settingsOf(context).auto, true)) return undefined;
	return { context: `Auto mode (kalfa meter): ${AUTO_RULE}` };
}

export function meterModuleWith(deps: ResetDeps) {
	return {
		name: 'meter',
		settings,
		filters: { 'prompt.submit': '"prompt"[[:space:]]*:[[:space:]]*"[[:space:]]*/meter([[:space:]]|")' },
		minContext: { 'prompt.submit': GUARD_FROM, 'tool.after': GUARD_FROM },
		handlers: {
			'session.start': (event, context) => sessionStart(event, context),
			'prompt.submit': (event, context) => meter(event, context),
			'tool.after': (event, context) => meter(event, context),
			'section.close': (event, context) => sectionClose(event, context, deps),
		},
	} satisfies ModuleDefinition & { settings: typeof settings };
}

export const meterModule = meterModuleWith({ spawn: spawnWaiter, now: () => Date.now() });
