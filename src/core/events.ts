import type { Section } from './task-record.ts';

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
	/** The event comes from a subagent, which has a context of its own. */
	subagent?: boolean;
}

export type SessionStartSource = 'startup' | 'resume' | 'clear' | 'compact';

export type CoreEvent = EventBase &
	(
		| { name: 'session.start'; source: SessionStartSource }
		| { name: 'prompt.submit'; prompt: string }
		/** A shell command the agent is about to run. */
		| { name: 'command.before'; command: string }
		/** `durationMs`: how long the tool ran, without the wait for an approval. */
		| { name: 'tool.after'; tool: string; durationMs?: number }
		/** Raised by `kalfa section close` after the Section is written. */
		| { name: 'section.close'; task: string; record: string; section: Section }
		/** Raised by `kalfa task close` after the record is closed. */
		| { name: 'task.close'; task: string; record: string }
	);

/** What a handler gives back. Each part is optional. */
export interface HandlerResult {
	/** Text the agent reads. */
	context?: string;
	/** Stops the action, with the reason the agent reads. Honoured on `prompt.submit` and `command.before`. */
	block?: string;
	/** With `block` on `prompt.submit`: the prompt is answered by the hook and is not kept in the session. */
	quiet?: boolean;
	/** Ends the agent's turn, with the reason the Operator reads. Honoured on `tool.after`. */
	stop?: string;
	/** Text for the Operator only. */
	notice?: string;
}

/** The merged result of all handlers for one event. */
export interface DispatchResult {
	context: string[];
	block: string[];
	/** Every block asked to be quiet. */
	quiet: boolean;
	stop: string[];
	notice: string[];
}

export const BLOCKING_EVENTS: ReadonlySet<CoreEventName> = new Set(['prompt.submit', 'command.before']);
export const STOPPING_EVENTS: ReadonlySet<CoreEventName> = new Set(['tool.after']);
