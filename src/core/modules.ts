// A Module's code side: its handlers per Core event. Its declarative side
// (skills, rules, Capabilities, pins) is `module.yaml`, read by `kalfa build`.
import type { Capability } from './capabilities.ts';
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
}

/** The Core's own handlers; they run in every repository, first. */
export const CORE_MODULE = 'core';
