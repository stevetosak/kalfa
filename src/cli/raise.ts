// Raises a Core event from the CLI (`section.close`, `task.close`): the agent
// runs a kalfa command, so the harness, and the session when the harness says
// which, are found from the environment.
import type { Adapter } from '../adapters/adapter.ts';
import { dispatch } from '../core/dispatcher.ts';
import type { CoreEvent, DispatchResult } from '../core/events.ts';
import type { ModuleDefinition } from '../core/modules.ts';
import type { Project } from '../core/project.ts';
import { loadSettings } from '../core/settings.ts';
import type { Io } from './io.ts';

type Payload = CoreEvent extends infer E ? (E extends CoreEvent ? Omit<E, 'harness' | 'cwd'> : never) : never;

export async function raise(payload: Payload, project: Project, io: Io, adapters: ReadonlyMap<string, Adapter>, registry: ReadonlyMap<string, ModuleDefinition>): Promise<DispatchResult> {
	const adapter = [...adapters.values()].find((a) => a.detect(io.env));
	const sessionId = adapter?.currentSession?.(io.env);
	const transcript = sessionId ? adapter?.usage?.transcriptOf(io.env, sessionId) : undefined;
	const event = { ...payload, harness: adapter?.name ?? 'cli', cwd: io.cwd, ...(sessionId && { sessionId }), ...(transcript && { transcript }) } as CoreEvent;
	return dispatch(event, registry, { project, settings: loadSettings(io.env), env: io.env, capabilities: adapter?.capabilities ?? new Set(), usage: adapter?.usage, contextCap: adapter?.contextCap });
}

/** Prints what the handlers said: context for the agent on stdout, notices on stderr. */
export function report(result: DispatchResult, io: Io): void {
	for (const text of result.context) io.out(text);
	for (const text of result.notice) io.err(text);
}
