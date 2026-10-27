import { moduleFolders } from '../core/module-source.ts';
import type { ModuleDefinition } from '../core/modules.ts';
import type { Adapter } from '../adapters/adapter.ts';
import type { Command } from '../cli/command.ts';
import { guardrailsModule } from '../../modules/guardrails/handlers.ts';
import { herdrCommand } from '../../modules/herdr/command.ts';
import { herdrModule } from '../../modules/herdr/handlers.ts';
import { meterCommand } from '../../modules/meter/command.ts';
import { meterModule } from '../../modules/meter/handlers.ts';
import { coreModule } from './core.ts';

/** The Modules this kalfa ships with handlers, by name; the Core is one of them. */
export const modules: ReadonlyMap<string, ModuleDefinition> = new Map([coreModule, guardrailsModule, herdrModule, meterModule].map((m) => [m.name, m]));

/** The Modules' own CLI commands, `kalfa <module> …`; each says whether it needs its Module on in the repository. */
export const moduleCommands: Record<string, (adapters: ReadonlyMap<string, Adapter>) => Command> = {
	herdr: (adapters) => herdrCommand(adapters),
	meter: (adapters) => meterCommand(adapters),
};

/**
 * `registry` and every Module folder in `modulesRoot` that has no handlers: a
 * Module can be only skills, rules and approvals, and it is still a known name.
 */
export function withFolderModules(registry: ReadonlyMap<string, ModuleDefinition>, modulesRoot: string): ReadonlyMap<string, ModuleDefinition> {
	const all = new Map(registry);
	for (const name of moduleFolders(modulesRoot)) if (!all.has(name)) all.set(name, { name, handlers: {} });
	return all;
}
