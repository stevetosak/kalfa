// An Adapter only translates: a harness hook payload into a Core event, and the
// Dispatcher's merged result into what the harness reads. It holds no logic a
// Core test cannot reach.
import type { Capability } from '../core/capabilities.ts';
import type { CoreEvent, CoreEventName, DispatchResult } from '../core/events.ts';

export interface HookOutput {
	stdout?: string;
	stderr?: string;
	exitCode: number;
}

export interface Adapter {
	/** The Harness name used on the command line, e.g. `claude`. */
	name: string;
	capabilities: ReadonlySet<Capability>;
	/** Whether a command runs inside this harness (for events the CLI raises). */
	detect(env: NodeJS.ProcessEnv): boolean;
	/** The Core event in the payload; `undefined` when the payload is not one (e.g. a tool that is not a shell). */
	toEvent(name: CoreEventName, payload: unknown): CoreEvent | undefined;
	render(event: CoreEvent, result: DispatchResult): HookOutput;
}
