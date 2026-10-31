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

const harnessStateSchema = z.strictObject({
	/** The approval entries kalfa added to the harness's user settings. */
	approvals: z.strictObject({ allow: entries, ask: entries, deny: entries }),
	/**
	 * There when kalfa turned off the harness's own memory: the value the
	 * setting had before (`previous` left out when the setting was not there).
	 */
	'native-memory': z.strictObject({ previous: z.unknown().optional() }).optional(),
});

const installStateSchema = z.strictObject({
	schema: z.literal(1),
	/** Per harness, what kalfa wrote into its user settings. */
	harnesses: z.record(z.string(), harnessStateSchema).default({}),
});

export type InstallState = z.infer<typeof installStateSchema>;
/** What kalfa owns in one harness's user settings. */
export type HarnessState = z.infer<typeof harnessStateSchema>;
type NativeMemoryState = NonNullable<HarnessState['native-memory']>;

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
	/** Turn off the harness's own automatic memory; left out, kalfa puts back what it changed. */
	nativeMemoryOff?: boolean;
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
	/** What kalfa owns after the change: the approvals it added that are still there, and the memory setting. */
	owned: HarnessState;
}

/**
 * Sets or puts back the harness's own memory setting. kalfa owns it only when
 * kalfa changed it: a setting the Operator had already turned off stays theirs,
 * and one the Operator changed after the install is left as it is.
 */
function setNativeMemory(
	data: Record<string, unknown>,
	setting: UserFiles['nativeMemory'],
	off: boolean,
	owned: NativeMemoryState | undefined,
	report: string[],
): { data: Record<string, unknown>; owned: NativeMemoryState | undefined } {
	if (!setting) return { data, owned: undefined };
	const { key } = setting;
	const isOff = isDeepStrictEqual(data[key], setting.off);
	if (off) {
		if (isOff) return { data, owned };
		report.push(`own memory: off (${key}: ${JSON.stringify(setting.off)}); kalfa's Standing memory replaces it`);
		return { data: { ...data, [key]: setting.off }, owned: owned ?? (key in data ? { previous: data[key] } : {}) };
	}
	if (!owned) return { data, owned: undefined };
	if (!isOff) {
		report.push(`own memory: ${key} was changed by hand; left as it is`);
		return { data, owned: undefined };
	}
	const result = { ...data };
	if ('previous' in owned) result[key] = owned.previous;
	else delete result[key];
	report.push(`own memory: ${key} put back as it was before kalfa`);
	return { data: result, owned: undefined };
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
export function applyUser(home: string, user: UserFiles, want: UserWants, owned: HarnessState | undefined, options: UserOptions = {}): UserResult {
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

	const merged = mergeApprovals(tapped, user.approvals, want.approvals, owned?.approvals);
	report.push(...merged.report);
	const memory = setNativeMemory(merged.after, user.nativeMemory, want.nativeMemoryOff ?? false, owned?.['native-memory'], report);
	const after = memory.data;

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
	return { path, report, changed, owned: { approvals: merged.owned, ...(memory.owned ? { 'native-memory': memory.owned } : {}) } };
}
