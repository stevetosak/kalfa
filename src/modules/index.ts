import { moduleFolders } from '../core/module-source.ts';
import { type MachineStep, machineStepOf } from '../core/machine-step.ts';
import type { ModuleDefinition } from '../core/modules.ts';
import type { Adapter } from '../adapters/adapter.ts';
import type { Command } from '../cli/command.ts';
import { docsCommand } from '../../modules/docs/command.ts';
import { docsModule } from '../../modules/docs/handlers.ts';
import { guardrailsCommand } from '../../modules/guardrails/command.ts';
import { gitHooksStep } from '../../modules/guardrails/git-hooks.ts';
import { guardrailsModule } from '../../modules/guardrails/handlers.ts';
import { boardCommand, herdrCommand, spaceCommand } from '../../modules/herdr/command.ts';
import { herdrModule } from '../../modules/herdr/handlers.ts';
import { keyBindingStep } from '../../modules/herdr/key-binding.ts';
import { herdrPluginStep } from '../../modules/herdr/plugin.ts';
import { memoryCommand } from '../../modules/memory/command.ts';
import { memoryModule } from '../../modules/memory/handlers.ts';
import { meterCommand } from '../../modules/meter/command.ts';
import { meterModule } from '../../modules/meter/handlers.ts';
import { deferCommand } from '../../modules/plans/command.ts';
import { plansModule } from '../../modules/plans/handlers.ts';
import { coreModule } from './core.ts';

/** The Modules this kalfa ships with handlers, by name; the Core is one of them. */
export const modules: ReadonlyMap<string, ModuleDefinition> = new Map([coreModule, docsModule, guardrailsModule, herdrModule, memoryModule, meterModule, plansModule].map((m) => [m.name, m]));

/** The Modules' own CLI commands, `kalfa <name> …` (the Module's name, or a verb of its own); each says whether it needs its Module on in the repository. */
export const moduleCommands: Record<string, (adapters: ReadonlyMap<string, Adapter>) => Command> = {
	docs: () => docsCommand(),
	guardrails: () => guardrailsCommand(),
	herdr: (adapters) => herdrCommand(adapters),
	board: (adapters) => boardCommand(adapters),
	space: (adapters) => spaceCommand(adapters),
	memory: () => memoryCommand(),
	meter: (adapters) => meterCommand(adapters),
	defer: () => deferCommand(),
};

/** The Modules' own parts of `kalfa install` / `uninstall`, by Module name. */
export const machineSteps: ReadonlyMap<string, MachineStep> = new Map([
	['guardrails', gitHooksStep()],
	['herdr', machineStepOf(herdrPluginStep(), keyBindingStep())],
]);

/**
 * `registry` and every Module in the Module folders `dirs` that has no handlers: a
 * Module can be only skills, rules and approvals, and it is still a known name.
 */
export function withFolderModules(registry: ReadonlyMap<string, ModuleDefinition>, dirs: readonly string[]): ReadonlyMap<string, ModuleDefinition> {
	const all = new Map(registry);
	for (const name of moduleFolders(dirs)) if (!all.has(name)) all.set(name, { name, handlers: {} });
	return all;
}
