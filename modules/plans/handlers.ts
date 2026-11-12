// The plans Module's code: at session start the open deferred items of the
// layers the session sees, next to the Core's open Plans (ADR 0002, amendment
// 2026-11-08). The rest of the Module is its skills: defer and kalfa-status.
import type { CoreEvent, HandlerResult } from '../../src/core/events.ts';
import { memoryHome, sessionLayers } from '../../src/core/memory/home.ts';
import type { HandlerContext, ModuleDefinition } from '../../src/core/modules.ts';
import { itemLine, scanDeferred } from './deferred.ts';

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

function sessionStart(event: CoreEvent, context: HandlerContext): HandlerResult | undefined {
	if (event.name !== 'session.start' || event.subagent) return undefined;
	const lines: string[] = [];
	const problems: string[] = [];
	for (const layer of sessionLayers(memoryHome(context.env), context.project)) {
		const scan = scanDeferred(layer);
		problems.push(...scan.problems);
		for (const item of scan.items) if (item.header.status === 'open') lines.push(itemLine(item, layer));
	}
	const notice = [lines.length ? `kalfa: plans: ${plural(lines.length, 'deferred item')}` : undefined, problems.length ? `kalfa: deferred items left out: ${problems.join('; ')}` : undefined]
		.filter(Boolean)
		.join('\n');
	if (!lines.length) return notice ? { notice } : undefined;
	return {
		context: ['Deferred items (kalfa defer list). The Operator takes one on; a condition is only something to report, it never starts the work:', ...lines].join('\n'),
		notice,
	};
}

export const plansModule = {
	name: 'plans',
	handlers: { 'session.start': sessionStart },
} satisfies ModuleDefinition;
