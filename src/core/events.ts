// The harness-neutral moments of a session. An Adapter turns a harness hook
// into one of these; Modules handle them and never see a harness payload.

export const CORE_EVENTS = ['session.start', 'prompt.submit', 'command.before', 'tool.after', 'section.close', 'task.close'] as const;

export type CoreEventName = (typeof CORE_EVENTS)[number];

export function isCoreEventName(name: string): name is CoreEventName {
	return (CORE_EVENTS as readonly string[]).includes(name);
}

interface EventBase {
	/** The Harness the session runs in, e.g. `claude`. */
	harness: string;
	cwd: string;
	sessionId?: string;
	/** The session transcript; only from an Adapter with the `transcript` Capability. */
	transcript?: string;
}

export type SessionStartSource = 'startup' | 'resume' | 'clear' | 'compact';

export type CoreEvent = EventBase &
	(
		| { name: 'session.start'; source: SessionStartSource }
		| { name: 'prompt.submit'; prompt: string }
		/** A shell command the agent is about to run. */
		| { name: 'command.before'; command: string }
		| { name: 'tool.after'; tool: string }
		| { name: 'section.close' }
		| { name: 'task.close' }
	);

/** What a handler gives back. Each part is optional. */
export interface HandlerResult {
	/** Text the agent reads. */
	context?: string;
	/** Stops the action, with the reason the agent reads. Honoured on `prompt.submit` and `command.before`. */
	block?: string;
	/** Text for the Operator only. */
	notice?: string;
}

/** The merged result of all handlers for one event. */
export interface DispatchResult {
	context: string[];
	block: string[];
	notice: string[];
}

export const BLOCKING_EVENTS: ReadonlySet<CoreEventName> = new Set(['prompt.submit', 'command.before']);
