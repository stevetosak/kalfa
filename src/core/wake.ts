// A wake: a handler asks the shim to start Node, once, for the next event of
// one name in the same session, for an event the shim does not run on its own
// (a Module's `wakeOnly`). A handler asks with `HandlerResult.wake`; the
// Dispatcher writes the marker, takes it before the handlers of that event
// run, and gives each Module the data it left. The marker is
// `<repo>/.kalfa/wake/<event>.<session>`, so parallel sessions in one checkout
// do not take each other's wakes; `<event>` alone when the harness gives no
// session id. The shim only checks that the session's marker exists.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { CoreEventName } from './events.ts';
import { PRIVATE_DIR, privateDir } from './private-dir.ts';

export const WAKE_DIR = 'wake';

/** A session that never sends the event leaves its marker; a marker older than this is removed. */
const WAKE_DAYS = 2;

/** What a marker holds: each Module's data, by the Module's name. */
const markerSchema = z.record(z.string(), z.record(z.string(), z.string()));

export type Wakes = z.infer<typeof markerSchema>;

/** The session id as a file name part; the shim makes the same change. */
export const sessionTag = (session: string): string => session.replace(/[^A-Za-z0-9_-]/g, '_');

export function wakePath(root: string, event: CoreEventName, session: string | undefined): string {
	return join(root, PRIVATE_DIR, WAKE_DIR, session ? `${event}.${sessionTag(session)}` : event);
}

/** A broken marker, or one in an older format, counts as none. */
function readMarker(path: string): Wakes | undefined {
	try {
		return markerSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
	} catch {
		return undefined;
	}
}

function prune(dir: string, now: number): void {
	for (const name of readdirSync(dir)) {
		const path = join(dir, name);
		if (now - statSync(path).mtimeMs > WAKE_DAYS * 86_400_000) rmSync(path, { force: true });
	}
}

/** Asks the shim to start Node on the next `event` of `session` in this checkout; the Module's newer data replaces its older data. */
export function setWake(root: string, event: CoreEventName, session: string | undefined, module: string, data: Readonly<Record<string, string>>, now = Date.now()): void {
	const dir = join(privateDir(root), WAKE_DIR);
	mkdirSync(dir, { recursive: true });
	const path = wakePath(root, event, session);
	writeFileSync(path, `${JSON.stringify({ ...readMarker(path), [module]: data })}\n`);
	prune(dir, now);
}

/** Takes the session's wake for `event`: the marker is removed in every case, so it starts Node once. */
export function takeWake(root: string, event: CoreEventName, session: string | undefined): Wakes | undefined {
	const path = wakePath(root, event, session);
	if (!existsSync(path)) return undefined;
	try {
		return readMarker(path);
	} finally {
		rmSync(path, { force: true });
	}
}
