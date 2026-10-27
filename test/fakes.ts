import type { Adapter } from '../src/adapters/adapter.ts';
import { CAPABILITIES, type Capability } from '../src/core/capabilities.ts';
import type { CoreEvent, CoreEventName } from '../src/core/events.ts';
import type { HandlerContext, ModuleDefinition } from '../src/core/modules.ts';
import { DEFAULT_SETTINGS } from '../src/core/settings.ts';

/** An Adapter whose payload is `{ cwd, ...fields }` and whose output is the merged result as JSON. */
export const fakeAdapter: Adapter = {
	name: 'fake',
	capabilities: new Set(Object.keys(CAPABILITIES) as Capability[]),
	toEvent(name: CoreEventName, payload: unknown) {
		const p = payload as Record<string, unknown>;
		if (p.skip) return undefined;
		return { harness: 'fake', cwd: '/', name, source: 'startup', prompt: '', command: '', tool: '', ...p } as CoreEvent;
	},
	render(_event, result) {
		return { stdout: JSON.stringify(result), exitCode: result.block.length ? 2 : 0 };
	},
};

export function registry(...modules: ModuleDefinition[]): Map<string, ModuleDefinition> {
	return new Map(modules.map((m) => [m.name, m]));
}

export function handlerContext(modules: string[] | undefined, root = '/repo'): HandlerContext {
	return {
		project: { root, file: modules ? { schema: 1, modules } : undefined },
		settings: DEFAULT_SETTINGS,
		env: {},
		capabilities: fakeAdapter.capabilities,
	};
}
