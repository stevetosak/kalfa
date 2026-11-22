// The Dispatcher runs the handlers of the Core and of the enabled Modules for
// one Core event, in that order, and merges their results. It owns the wakes
// (core/wake.ts): it takes the session's wake for the event before the
// handlers run, gives each Module its own data, and writes the wakes the
// handlers ask for.
import type { CoreEvent, DispatchResult, HandlerResult } from './events.ts';
import { BLOCKING_EVENTS, STOPPING_EVENTS } from './events.ts';
import { CORE_MODULE, type HandlerContext, handlesEvent, type ModuleDefinition } from './modules.ts';
import { isPrivateDirIgnored } from './private-dir.ts';
import { setWake, takeWake } from './wake.ts';

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
	// A subagent shares the session id but not the conversation: it neither takes nor sets a wake.
	const root = event.subagent ? undefined : context.project?.root;
	const wakes = root ? takeWake(root, event.name, event.sessionId) : undefined;

	for (const module of modules) {
		const handler = module.handlers[event.name];
		if (!handler || !handlesEvent(module, event.name, context)) continue;
		try {
			const wake = wakes?.[module.name];
			const out = await handler(event, wake ? { ...context, wake } : context);
			if (out?.context) result.context.push(out.context);
			if (out?.notice) result.notice.push(out.notice);
			if (out?.block && BLOCKING_EVENTS.has(event.name)) {
				result.block.push(out.block);
				result.quiet &&= out.quiet === true;
			}
			if (out?.stop && STOPPING_EVENTS.has(event.name)) result.stop.push(out.stop);
			if (out?.wake && root) writeWake(root, event, module.name, out.wake);
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

/** Writes a wake a handler asked for; in a checkout that does not ignore `.kalfa/` there is no kalfa state to wake for, so none. */
function writeWake(root: string, event: CoreEvent, module: string, wake: NonNullable<HandlerResult['wake']>): void {
	if (isPrivateDirIgnored(root)) setWake(root, wake.event, event.sessionId, module, wake.data ?? {});
}
