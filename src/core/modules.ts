// A Module's code side: its handlers per Core event. Its declarative side
// (skills, rules, Capabilities, pins) is `module.yaml`, read by `kalfa build`.
import type { z } from 'zod';
import type { Capability } from './capabilities.ts';
import { KalfaError } from './errors.ts';
import type { CoreEvent, CoreEventName, HandlerResult } from './events.ts';
import type { Project } from './project.ts';
import type { Settings } from './settings.ts';

export interface HandlerContext {
	project: Project | undefined;
	settings: Settings;
	env: NodeJS.ProcessEnv;
	/** The Capabilities of the Adapter that raised the event. */
	capabilities: ReadonlySet<Capability>;
}

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
	/** The schema of the Module's part of `settings:` in `kalfa.yaml`. */
	settings?: z.ZodType;
}

/** The Module's settings from `kalfa.yaml`, checked against its schema (defaults filled in). */
export function moduleSettings<S extends z.ZodType>(module: ModuleDefinition & { settings: S }, project: Project | undefined): z.infer<S> {
	const result = module.settings.safeParse(project?.file?.settings[module.name] ?? {});
	if (!result.success) throw new KalfaError(`kalfa.yaml settings.${module.name}: ${result.error.issues.map((i) => `${i.path.join('.') || '(top)'}: ${i.message}`).join('; ')}`);
	return result.data;
}

/** The Core's own handlers; they run in every repository, first. */
export const CORE_MODULE = 'core';
