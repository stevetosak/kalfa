import { moduleFolders } from '../core/module-source.ts';
import type { ModuleDefinition } from '../core/modules.ts';
import type { Adapter } from '../adapters/adapter.ts';
import type { Command } from '../cli/command.ts';
import type { MemoryExtension } from '../cli/commands/memory.ts';
import { docsCommand } from '../../modules/docs/command.ts';
import { docsModule } from '../../modules/docs/handlers.ts';
import { guardrailsModule } from '../../modules/guardrails/handlers.ts';
import { herdrCommand } from '../../modules/herdr/command.ts';
import { herdrModule } from '../../modules/herdr/handlers.ts';
import { memoryExtension } from '../../modules/memory/command.ts';
import { memoryModule } from '../../modules/memory/handlers.ts';
import { meterCommand } from '../../modules/meter/command.ts';
import { meterModule } from '../../modules/meter/handlers.ts';
import { coreModule } from './core.ts';

/** The Modules this kalfa ships with handlers, by name; the Core is one of them. */
export const modules: ReadonlyMap<string, ModuleDefinition> = new Map([coreModule, docsModule, guardrailsModule, herdrModule, memoryModule, meterModule].map((m) => [m.name, m]));

/** The Modules' own CLI commands, `kalfa <module> …`; each says whether it needs its Module on in the repository. */
export const moduleCommands: Record<string, (adapters: ReadonlyMap<string, Adapter>) => Command> = {
	docs: () => docsCommand(),
	herdr: (adapters) => herdrCommand(adapters),
	meter: (adapters) => meterCommand(adapters),
};

/** The Modules' subcommands of the Core's `kalfa memory`; each checks that its Module is on. */
export const memoryExtensions: readonly MemoryExtension[] = [memoryExtension];

/**
 * `registry` and every Module folder in `modulesRoot` that has no handlers: a
 * Module can be only skills, rules and approvals, and it is still a known name.
 */
export function withFolderModules(registry: ReadonlyMap<string, ModuleDefinition>, modulesRoot: string): ReadonlyMap<string, ModuleDefinition> {
	const all = new Map(registry);
	for (const name of moduleFolders(modulesRoot)) if (!all.has(name)) all.set(name, { name, handlers: {} });
	return all;
}
