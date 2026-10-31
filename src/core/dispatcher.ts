// The Dispatcher runs the handlers of the Core and of the enabled Modules for
// one Core event, in that order, and merges their results.
import type { CoreEvent, DispatchResult } from './events.ts';
import { BLOCKING_EVENTS, STOPPING_EVENTS } from './events.ts';
import { CORE_MODULE, type HandlerContext, type ModuleDefinition } from './modules.ts';

/**
 * The Modules that run in this context, each once: the Core, then the
 * machine's own Modules, then those the project file adds.
 */
export function activeModules(
	registry: ReadonlyMap<string, ModuleDefinition>,
	context: Pick<HandlerContext, 'project' | 'settings'>,
): { modules: ModuleDefinition[]; unknown: string[] } {
	const names = new Set([CORE_MODULE, ...context.settings.modules, ...(context.project?.file?.modules ?? [])]);
	const modules: ModuleDefinition[] = [];
	const unknown: string[] = [];
	for (const name of names) {
		const module = registry.get(name);
		if (module) modules.push(module);
		else if (name !== CORE_MODULE) unknown.push(name);
	}
	return { modules, unknown };
}

export async function dispatch(event: CoreEvent, registry: ReadonlyMap<string, ModuleDefinition>, context: HandlerContext): Promise<DispatchResult> {
	const result: DispatchResult = { context: [], block: [], quiet: true, stop: [], notice: [] };
	const { modules, unknown } = activeModules(registry, context);
	if (unknown.length) result.notice.push(`kalfa: kalfa.yaml or the machine settings name unknown Module(s): ${unknown.join(', ')}; check \`kalfa doctor\``);

	for (const module of modules) {
		const handler = module.handlers[event.name];
		if (!handler) continue;
		try {
			const out = await handler(event, context);
			if (out?.context) result.context.push(out.context);
			if (out?.notice) result.notice.push(out.notice);
			if (out?.block && BLOCKING_EVENTS.has(event.name)) {
				result.block.push(out.block);
				result.quiet &&= out.quiet === true;
			}
			if (out?.stop && STOPPING_EVENTS.has(event.name)) result.stop.push(out.stop);
		} catch (error) {
			const message = `kalfa: Module ${module.name} failed on ${event.name}: ${(error as Error).message}`;
			if (module.failClosed?.includes(event.name) && BLOCKING_EVENTS.has(event.name)) {
				result.block.push(`${message} (the action is stopped because this guard could not run)`);
				result.quiet = false;
			} else result.notice.push(message);
		}
	}
	if (!result.block.length) result.quiet = false;
	return result;
}
