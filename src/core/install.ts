// `kalfa install` / `uninstall`: kalfa's entries in each harness's user
// settings, next to the Operator's own and other tools'. The hooks and the
// status-tap are kalfa's by the program they run; the approvals are kalfa's
// only when `install.yaml` in the machine config folder says kalfa added them,
// so an entry the Operator wrote is never taken away. A changed settings file
// is backed up next to itself before kalfa writes it.
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import type { UserFiles } from '../adapters/adapter.ts';
import { mergeApprovals, noApprovals } from './approvals.ts';
import { KalfaError } from './errors.ts';
import type { CoreEventName } from './events.ts';
import { machineConfigDir } from './machine-paths.ts';
import type { Approvals } from './module-source.ts';
import { readVersioned, type VersionedFormat } from './versioned-file.ts';

const entries = z.array(z.string()).default([]);

const installStateSchema = z.strictObject({
	schema: z.literal(1),
	/** Per harness, the approval entries kalfa added to its user settings. */
	harnesses: z.record(z.string(), z.strictObject({ approvals: z.strictObject({ allow: entries, ask: entries, deny: entries }) })).default({}),
});

export type InstallState = z.infer<typeof installStateSchema>;

const installStateFormat: VersionedFormat<InstallState> = { name: 'install.yaml', current: 1, schema: installStateSchema };

export const installStatePath = (env: NodeJS.ProcessEnv) => join(machineConfigDir(env), 'install.yaml');

export const readInstallState = (env: NodeJS.ProcessEnv): InstallState => readVersioned(installStatePath(env), installStateFormat) ?? { schema: 1, harnesses: {} };

/** Writes the state; with no harness left in it, the file goes. */
export function writeInstallState(env: NodeJS.ProcessEnv, state: InstallState): void {
	const path = installStatePath(env);
	if (!Object.keys(state.harnesses).length) {
		rmSync(path, { force: true });
		return;
	}
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`);
}

/** What kalfa wants in one harness's user settings; `undefined` parts are removed. */
export interface UserWants {
	hook?: (event: CoreEventName) => string;
	tap?: string;
	approvals: Approvals;
}

export const NOTHING: UserWants = { approvals: noApprovals() };

export interface UserOptions {
	dryRun?: boolean;
	/** The time in the backup's name. */
	now?: Date;
}

export interface UserResult {
	path: string;
	report: string[];
	changed: boolean;
	/** The approvals kalfa added and that are still there. */
	approvals: Approvals;
}

function readSettings(path: string): Record<string, unknown> | undefined {
	if (!existsSync(path)) return undefined;
	let data: unknown;
	try {
		data = JSON.parse(readFileSync(path, 'utf8'));
	} catch (error) {
		throw new KalfaError(`${path}: not valid JSON (${(error as Error).message}); kalfa changed nothing`);
	}
	if (typeof data !== 'object' || data === null || Array.isArray(data)) throw new KalfaError(`${path}: not a JSON object; kalfa changed nothing`);
	return data as Record<string, unknown>;
}

const backupPath = (path: string, now: Date) => `${path}.bak-kalfa-${now.toISOString().replace(/[:.]/g, '-')}`;

/** Brings kalfa's entries in one harness's user settings under `home` to `want`. Checks everything before it writes. */
export function applyUser(home: string, user: UserFiles, want: UserWants, added: Approvals | undefined, options: UserOptions = {}): UserResult {
	const path = join(home, user.settings);
	const existing = readSettings(path);
	const before = existing ?? {};
	const report: string[] = [];

	const hooked = user.hooks(before, want.hook);
	if (hooked !== before) report.push(want.hook ? 'hooks: write kalfa-hook for every Core event' : "hooks: remove kalfa's hooks");

	const tapped = user.statusLine ? user.statusLine(hooked, want.tap) : hooked;
	if (tapped !== hooked) {
		const line = (data: Record<string, unknown>) => (data.statusLine as { command?: string } | undefined)?.command;
		report.push(line(tapped) === undefined ? 'status line: remove' : `status line: ${line(tapped)}`);
	}

	const merged = mergeApprovals(tapped, user.approvals, want.approvals, added);
	report.push(...merged.report);
	const after = merged.after;

	const changed = after !== before && !(existing === undefined && isDeepStrictEqual(after, {}));
	if (!changed) report.push('nothing to change');
	if (changed && !options.dryRun) {
		if (existing !== undefined) {
			const backup = backupPath(path, options.now ?? new Date());
			copyFileSync(path, backup);
			report.push(`backup ${backup}`);
		}
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, `${JSON.stringify(after, null, 2)}\n`);
	}
	return { path, report, changed, approvals: merged.owned };
}
