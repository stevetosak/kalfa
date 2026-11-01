// A wake: a handler asks for the next event of one name to start Node, once,
// for an event the shim does not run on its own (a Module lists it in
// `wakeOnly`). The marker is `<repo>/.kalfa/wake/<event>`; the shim only
// checks that it exists, and the handler that takes it reads what it holds.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { CoreEventName } from './events.ts';
import { PRIVATE_DIR, privateDir } from './private-dir.ts';

export const WAKE_DIR = 'wake';

const wakeSchema = z.strictObject({
	/** The session that asked; a wake taken in another session is dropped. */
	session: z.string().optional(),
	/** What the handler needs, e.g. the Task id. */
	data: z.record(z.string(), z.string()),
});

export type Wake = z.infer<typeof wakeSchema>;

export function wakePath(root: string, event: CoreEventName): string {
	return join(root, PRIVATE_DIR, WAKE_DIR, event);
}

/** Asks the shim to start Node on the next `event` in this repository; a newer wake replaces an older one. */
export function setWake(root: string, event: CoreEventName, wake: Wake): void {
	const dir = join(privateDir(root), WAKE_DIR);
	mkdirSync(dir, { recursive: true });
	writeFileSync(wakePath(root, event), `${JSON.stringify(wake)}\n`);
}

/**
 * Takes the wake for `event`: it is removed in every case, so it starts Node
 * once. It is given back only for the session that set it; a broken or
 * foreign marker counts as none.
 */
export function takeWake(root: string, event: CoreEventName, session: string | undefined): Wake | undefined {
	const path = wakePath(root, event);
	if (!existsSync(path)) return undefined;
	let text: string;
	try {
		text = readFileSync(path, 'utf8');
	} finally {
		rmSync(path, { force: true });
	}
	try {
		const wake = wakeSchema.parse(JSON.parse(text));
		return wake.session === session ? wake : undefined;
	} catch {
		return undefined;
	}
}
