// A Module's code side: its handlers per Core event. Its declarative side
// (skills, rules, Capabilities, pins) is `module.yaml`, read by `kalfa build`.
import type { z } from 'zod';
import type { Capability } from './capabilities.ts';
import { KalfaError } from './errors.ts';
import type { CoreEvent, CoreEventName, HandlerResult } from './events.ts';
import type { Project } from './project.ts';
import type { Settings } from './settings.ts';
import type { UsageSource } from './usage.ts';

export interface HandlerContext {
	project: Project | undefined;
	settings: Settings;
	env: NodeJS.ProcessEnv;
	/** The Capabilities of the Adapter that raised the event. */
	capabilities: ReadonlySet<Capability>;
	/** The token use of the session, from an Adapter with the `usage` Capability. */
	usage?: UsageSource;
}

/** What decides whether a handler runs here: the project and the machine settings, nothing from the event. */
export type GateContext = Pick<HandlerContext, 'project' | 'settings'>;

export type Handler = (event: CoreEvent, context: HandlerContext) => Promise<HandlerResult | undefined> | HandlerResult | undefined;

export interface ModuleDefinition {
	name: string;
	handlers: Partial<Record<CoreEventName, Handler>>;
	/**
	 * Events whose handler failure stops the action instead of letting it pass
	 * with a notice (a guard that cannot run must not wave a push through).
	 */
	failClosed?: CoreEventName[];
	/**
	 * Per event, a POSIX extended regex over the raw hook payload: the shim
	 * starts Node for this Module only on a match. It must match every payload
	 * the handler acts on; no filter means every payload.
	 */
	filters?: Partial<Record<CoreEventName, string>>;
	/**
	 * Per event, the context size (tokens) from which the shim also starts Node
	 * for this Module, as the Adapter's context probe measures it. With a
	 * filter, either one is enough.
	 */
	minContext?: Partial<Record<CoreEventName, number>>;
	/**
	 * Per event, whether the handler runs here at all (a setting turns it on).
	 * When it says no, the shim does not start Node for this Module and the
	 * Dispatcher skips the handler, so a feature that is off costs nothing.
	 */
	when?: Partial<Record<CoreEventName, (context: GateContext) => boolean>>;
	/** The schema of the Module's part of `settings:` in `kalfa.yaml`. */
	settings?: z.ZodType;
}

const settingsObject = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {});

/**
 * The Module's settings, checked against its schema (defaults filled in): the
 * machine settings' part, then `kalfa.yaml`'s part over it, key by key.
 */
export function moduleSettings<S extends z.ZodType>(module: ModuleDefinition & { settings: S }, project: Project | undefined, machine?: Settings): z.infer<S> {
	const merged = { ...settingsObject(machine?.settings?.[module.name]), ...settingsObject(project?.file?.settings[module.name]) };
	const result = module.settings.safeParse(merged);
	if (!result.success) throw new KalfaError(`settings.${module.name} (kalfa.yaml or the machine settings): ${result.error.issues.map((i) => `${i.path.join('.') || '(top)'}: ${i.message}`).join('; ')}`);
	return result.data;
}

/**
 * The Module has a handler for the event that runs here. A gate that fails
 * (a broken setting) counts as yes, so the handler runs and reports the error.
 */
export function handlesEvent(module: ModuleDefinition, name: CoreEventName, context: GateContext | undefined): boolean {
	if (!module.handlers[name]) return false;
	const gate = module.when?.[name];
	if (!gate || !context) return true;
	try {
		return gate(context);
	} catch {
		return true;
	}
}

/** The Module runs here: the machine settings or the project file turn it on. */
export function isModuleOn(name: string, project: Project | undefined, machine: Settings): boolean {
	return machine.modules.includes(name) || (project?.file?.modules.includes(name) ?? false);
}

/** The Core's own handlers; they run in every repository, first. */
export const CORE_MODULE = 'core';
