// The fast path: the `kalfa-hook` shim starts Node only when a handler can run.
// The Core's events are built into the shim. The Module events are in an
// event table: in a repository with `kalfa.yaml`, `.kalfa/events` (the
// machine's Modules and the project's); elsewhere the machine table in the
// cache folder (the machine's Modules alone). A table is rewritten when it is
// older than a file it is made from. One line per
// event, the name alone (always run), or the name, a tab and a regex that the
// raw payload must match (the Modules' filters joined; see ModuleDefinition),
// then optionally a tab and the context size from which Node runs anyway (the
// smallest `minContext`; the regex is empty when only that counts).
import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CORE_EVENTS, type CoreEventName } from './events.ts';
import { type GateContext, handlesEvent, type ModuleDefinition } from './modules.ts';
import { machineCacheDir } from './machine-paths.ts';
import { privateDir } from './private-dir.ts';

export const EVENT_TABLE = 'events';

/** The events a handler runs for here; `context` applies the Modules' `when` gates. */
export function handledEvents(modules: Iterable<ModuleDefinition>, context?: GateContext): CoreEventName[] {
	const list = [...modules];
	return CORE_EVENTS.filter((name) => list.some((m) => handlesEvent(m, name, context)));
}

/** One event table line: the event, and its conditions unless a Module that handles it has none. */
function tableLine(name: CoreEventName, modules: ModuleDefinition[], context: GateContext | undefined): string {
	const handling = modules.filter((m) => handlesEvent(m, name, context));
	if (handling.some((m) => m.filters?.[name] === undefined && m.minContext?.[name] === undefined)) return name;
	const filters = handling.flatMap((m) => (m.filters?.[name] === undefined ? [] : [`(${m.filters[name]})`]));
	const sizes = handling.flatMap((m) => (m.minContext?.[name] === undefined ? [] : [m.minContext[name]]));
	const line = `${name}\t${filters.join('|')}`;
	return sizes.length ? `${line}\t${Math.min(...sizes)}` : line;
}

function writeTable(path: string, modules: Iterable<ModuleDefinition>, context: GateContext | undefined): string {
	const list = [...modules];
	writeFileSync(path, handledEvents(list, context).map((name) => `${tableLine(name, list, context)}\n`).join(''));
	return path;
}

/** Writes the repository's event table; returns its path. */
export function writeEventTable(root: string, modules: Iterable<ModuleDefinition>, context?: GateContext): string {
	return writeTable(join(privateDir(root), EVENT_TABLE), modules, context);
}

export function machineEventTablePath(env: NodeJS.ProcessEnv): string {
	return join(machineCacheDir(env), EVENT_TABLE);
}

/** Writes the machine's event table (the machine's Modules alone); returns its path. */
export function writeMachineEventTable(env: NodeJS.ProcessEnv, modules: Iterable<ModuleDefinition>, context?: GateContext): string {
	const path = machineEventTablePath(env);
	mkdirSync(join(path, '..'), { recursive: true });
	return writeTable(path, modules, context);
}

/** The shim's rule: a table counts only when it exists and is newer than every source that exists. */
export function isTableFresh(table: string, sources: string[]): boolean {
	const mtime = (path: string) => statSync(path, { throwIfNoEntry: false })?.mtimeMs;
	const at = mtime(table);
	if (at === undefined) return false;
	return sources.every((source) => {
		const sourceAt = mtime(source);
		return sourceAt === undefined || at > sourceAt;
	});
}
