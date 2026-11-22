// The plans Module's code: at session start the count of the open deferred
// items of the layers the session sees, next to the Core's open Plans (ADR
// 0002, amendment 2026-11-08; ADR 0003: a count, not the list, so that the
// list cannot grow the session report). `kalfa defer list` and /kalfa-status
// show the items. The rest of the Module is its skills: defer and kalfa-status.
import type { CoreEvent, HandlerResult } from '../../src/core/events.ts';
import { memoryHome, sessionLayers } from '../../src/core/memory/home.ts';
import type { HandlerContext, ModuleDefinition } from '../../src/core/modules.ts';
import { scanDeferred } from './deferred.ts';

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

interface LayerCount {
	layer: string;
	open: number;
	withCondition: number;
}

/** The one line the agent gets: how many items wait, in which layer, and how many have a condition to report. */
function countLine(counts: readonly LayerCount[]): string {
	const total = counts.reduce((n, c) => n + c.open, 0);
	const conditions = counts.reduce((n, c) => n + c.withCondition, 0);
	const perLayer = counts.map((c) => `${c.layer} ${c.open}`).join(', ');
	const withCondition = conditions ? `; ${conditions} with a condition` : '';
	return `Deferred items: ${total} open (${perLayer}${withCondition}). The list: kalfa defer list. The Operator takes one on; a condition is only something to report, it never starts the work.`;
}

function sessionStart(event: CoreEvent, context: HandlerContext): HandlerResult | undefined {
	if (event.name !== 'session.start' || event.subagent) return undefined;
	const counts: LayerCount[] = [];
	const problems: string[] = [];
	for (const layer of sessionLayers(memoryHome(context.env), context.project)) {
		const scan = scanDeferred(layer);
		problems.push(...scan.problems);
		const open = scan.items.filter((item) => item.header.status === 'open');
		if (open.length) counts.push({ layer: layer.name, open: open.length, withCondition: open.filter((item) => item.header.condition).length });
	}
	const total = counts.reduce((n, c) => n + c.open, 0);
	const notice = [total ? `kalfa: plans: ${plural(total, 'deferred item')}` : undefined, problems.length ? `kalfa: deferred items left out: ${problems.join('; ')}` : undefined]
		.filter(Boolean)
		.join('\n');
	if (!total) return notice ? { notice } : undefined;
	return { context: countLine(counts), notice };
}

export const plansModule = {
	name: 'plans',
	handlers: { 'session.start': sessionStart },
} satisfies ModuleDefinition;
