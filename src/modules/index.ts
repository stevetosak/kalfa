import { moduleFolders } from '../core/module-source.ts';
import type { ModuleDefinition } from '../core/modules.ts';
import { guardrailsModule } from '../../modules/guardrails/handlers.ts';
import { coreModule } from './core.ts';

/** The Modules this kalfa ships with handlers, by name; the Core is one of them. */
export const modules: ReadonlyMap<string, ModuleDefinition> = new Map([coreModule, guardrailsModule].map((m) => [m.name, m]));

/**
 * `registry` and every Module folder in `modulesRoot` that has no handlers: a
 * Module can be only skills, rules and approvals, and it is still a known name.
 */
export function withFolderModules(registry: ReadonlyMap<string, ModuleDefinition>, modulesRoot: string): ReadonlyMap<string, ModuleDefinition> {
	const all = new Map(registry);
	for (const name of moduleFolders(modulesRoot)) if (!all.has(name)) all.set(name, { name, handlers: {} });
	return all;
}
