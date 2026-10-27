// The fast path: the `kalfa-hook` shim starts Node only when a handler can run.
// The Core's events are built into the shim; a repository's Module events are
// in `.kalfa/events`, rewritten whenever the Modules change: one line per
// event, the name alone (always run), or the name, a tab and a regex that the
// raw payload must match (the Modules' filters joined; see ModuleDefinition),
// then optionally a tab and the context size from which Node runs anyway (the
// smallest `minContext`; the regex is empty when only that counts).
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CORE_EVENTS, type CoreEventName } from './events.ts';
import type { ModuleDefinition } from './modules.ts';
import { privateDir } from './private-dir.ts';

export const EVENT_TABLE = 'events';

export function handledEvents(modules: Iterable<ModuleDefinition>): CoreEventName[] {
	const handled = new Set<CoreEventName>();
	for (const module of modules) for (const name of Object.keys(module.handlers) as CoreEventName[]) handled.add(name);
	return CORE_EVENTS.filter((name) => handled.has(name));
}

/** One event table line: the event, and its conditions unless a Module that handles it has none. */
function tableLine(name: CoreEventName, modules: ModuleDefinition[]): string {
	const handling = modules.filter((m) => m.handlers[name]);
	if (handling.some((m) => m.filters?.[name] === undefined && m.minContext?.[name] === undefined)) return name;
	const filters = handling.flatMap((m) => (m.filters?.[name] === undefined ? [] : [`(${m.filters[name]})`]));
	const sizes = handling.flatMap((m) => (m.minContext?.[name] === undefined ? [] : [m.minContext[name]]));
	const line = `${name}\t${filters.join('|')}`;
	return sizes.length ? `${line}\t${Math.min(...sizes)}` : line;
}

/** Writes the repository's event table; returns its path. */
export function writeEventTable(root: string, modules: Iterable<ModuleDefinition>): string {
	const list = [...modules];
	const path = join(privateDir(root), EVENT_TABLE);
	writeFileSync(path, handledEvents(list).map((name) => `${tableLine(name, list)}\n`).join(''));
	return path;
}
