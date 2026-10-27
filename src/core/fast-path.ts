// The fast path: the `kalfa-hook` shim starts Node only when a handler can run.
// The Core's events are built into the shim; a repository's Module events are
// in `.kalfa/events`, one name per line, rewritten whenever the Modules change.
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

/** Writes the repository's event table; returns its path. */
export function writeEventTable(root: string, modules: Iterable<ModuleDefinition>): string {
	const path = join(privateDir(root), EVENT_TABLE);
	writeFileSync(path, handledEvents(modules).map((name) => `${name}\n`).join(''));
	return path;
}
