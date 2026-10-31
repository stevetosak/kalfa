// The meter Module's code: the context meter and the idle guard on every
// prompt and after every tool (guard.ts decides). The shim starts Node for it
// only from GUARD_FROM tokens of context, or for a /meter prompt.
import { z } from 'zod';
import { currentBranch } from '../../src/core/git.ts';
import type { CoreEvent, HandlerResult } from '../../src/core/events.ts';
import { type HandlerContext, type ModuleDefinition, moduleSettings } from '../../src/core/modules.ts';
import type { Project } from '../../src/core/project.ts';
import { readRecord, taskIdOf } from '../../src/core/task-record.ts';
import { COMPACT_AT, GUARD_FROM } from './budget.ts';
import { decide, type Verdict } from './guard.ts';
import { readState, stateDir, writeState } from './state.ts';

const settings = z.strictObject({
	/** The compact point in tokens; the meter does not run below GUARD_FROM. */
	'compact-at': z.number().int().min(GUARD_FROM).default(COMPACT_AT),
});

/** What the Operator can do instead of writing the whole context again. */
export function freshStart(project: Project | undefined): string {
	const branch = project && currentBranch(project.root);
	const record = branch ? readRecord(project.root, taskIdOf(branch)) : undefined;
	if (record?.header.status === 'open') return `Task ${record.id} is open: record the Section with \`kalfa section close\`, then /clear shows its Handoff in a fresh, small session.`;
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
		compactAt: moduleSettings(meterModule, context.project, context.settings)['compact-at'],
		fresh: () => freshStart(context.project),
	});
	if (JSON.stringify(state) !== JSON.stringify(before)) writeState(dir, event.sessionId, state);
	return toResult(verdict);
}

export const meterModule = {
	name: 'meter',
	settings,
	filters: { 'prompt.submit': '"prompt"[[:space:]]*:[[:space:]]*"[[:space:]]*/meter([[:space:]]|")' },
	minContext: { 'prompt.submit': GUARD_FROM, 'tool.after': GUARD_FROM },
	handlers: { 'prompt.submit': (event, context) => meter(event, context), 'tool.after': (event, context) => meter(event, context) },
} satisfies ModuleDefinition & { settings: typeof settings };
