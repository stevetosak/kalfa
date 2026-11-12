// `kalfa install` / `uninstall`: kalfa's entries in each harness's user
// settings, next to the Operator's own and other tools'. The hooks and the
// status-tap are kalfa's by the program they run; the approvals are kalfa's
// only when `install.yaml` in the machine config folder says kalfa added them,
// so an entry the Operator wrote is never taken away. The same holds for the
// settings kalfa sets (the Adapter's `owned` list): kalfa owns one only when it
// changed it, and puts back the earlier value. A changed settings file
// is backed up next to itself before kalfa writes it.
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import type { OwnedSetting, UserFiles } from '../adapters/adapter.ts';
import { mergeApprovals, noApprovals } from './approvals.ts';
import { KalfaError } from './errors.ts';
import type { CoreEventName } from './events.ts';
import { machineConfigDir } from './machine-paths.ts';
import type { Approvals } from './module-source.ts';
import { readVersioned, type VersionedFormat } from './versioned-file.ts';

const entries = z.array(z.string()).default([]);

/** A setting kalfa changed: the value it had before (`previous` left out when it was not there). */
const settingStateSchema = z.strictObject({ previous: z.unknown().optional() });
type SettingState = z.infer<typeof settingStateSchema>;

const harnessStateSchema = z
	.strictObject({
		/** The approval entries kalfa added to the harness's user settings. */
		approvals: z.strictObject({ allow: entries, ask: entries, deny: entries }),
		/** The settings kalfa changed, by their name in the Adapter's `owned` list. */
		settings: z.record(z.string(), settingStateSchema).optional(),
		/** Before the `settings` map: the harness's own memory setting. Read, never written. */
		'native-memory': settingStateSchema.optional(),
	})
	.transform(({ 'native-memory': memory, ...state }) => (memory ? { ...state, settings: { 'native-memory': memory, ...state.settings } } : state));

const installStateSchema = z.strictObject({
	schema: z.literal(1),
	/** Per harness, what kalfa wrote into its user settings. */
	harnesses: z.record(z.string(), harnessStateSchema).default({}),
});

export type InstallState = z.infer<typeof installStateSchema>;
/** What kalfa owns in one harness's user settings. */
export type HarnessState = z.output<typeof harnessStateSchema>;

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
	/** Set the Adapter's `owned` settings; left out, kalfa puts back what it changed. */
	ownedSettings?: boolean;
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
	/** What kalfa owns after the change: the approvals it added that are still there, and the settings it changed. */
	owned: HarnessState;
}

type Data = Record<string, unknown>;
const isObject = (value: unknown): value is Data => typeof value === 'object' && value !== null && !Array.isArray(value);

function getAt(data: Data, path: readonly string[]): { found: boolean; value?: unknown } {
	let node: unknown = data;
	for (const key of path) {
		if (!isObject(node) || !(key in node)) return { found: false };
		node = node[key];
	}
	return { found: true, value: node };
}

/** `data` with the value at `path` set, or removed when `value` is left out; a parent left empty goes too. */
function setAt(data: Data, path: readonly string[], ...value: [unknown?]): Data {
	const [key, ...rest] = path;
	if (key === undefined) return data;
	const result = { ...data };
	if (rest.length) {
		const child = setAt(isObject(data[key]) ? data[key] : {}, rest, ...value);
		if (Object.keys(child).length) result[key] = child;
		else delete result[key];
	} else if (value.length) result[key] = value[0];
	else delete result[key];
	return result;
}

/**
 * Sets or puts back one setting. kalfa owns it only when kalfa changed it: a
 * setting that already had kalfa's value stays the Operator's, and one the
 * Operator changed after the install is left as it is.
 */
function applySetting(data: Data, setting: OwnedSetting, set: boolean, owned: SettingState | undefined, report: string[]): { data: Data; owned: SettingState | undefined } {
	const where = setting.path.join('.');
	const now = getAt(data, setting.path);
	const isSet = now.found && isDeepStrictEqual(now.value, setting.value);
	if (set) {
		if (isSet) return { data, owned };
		report.push(`${setting.name}: ${where} = ${JSON.stringify(setting.value)}; ${setting.why}`);
		return { data: setAt(data, setting.path, setting.value), owned: owned ?? (now.found ? { previous: now.value } : {}) };
	}
	if (!owned) return { data, owned: undefined };
	if (!isSet) {
		report.push(`${setting.name}: ${where} was changed by hand; left as it is`);
		return { data, owned: undefined };
	}
	report.push(`${setting.name}: ${where} put back as it was before kalfa`);
	return { data: 'previous' in owned ? setAt(data, setting.path, owned.previous) : setAt(data, setting.path), owned: undefined };
}

function applySettings(data: Data, settings: readonly OwnedSetting[], set: boolean, owned: HarnessState['settings'], report: string[]): { data: Data; owned: HarnessState['settings'] } {
	const after: NonNullable<HarnessState['settings']> = {};
	for (const setting of settings) {
		const result = applySetting(data, setting, set, owned?.[setting.name], report);
		data = result.data;
		if (result.owned) after[setting.name] = result.owned;
	}
	return { data, owned: Object.keys(after).length ? after : undefined };
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
	const settings = applySettings(merged.after, user.owned ?? [], want.ownedSettings ?? false, owned?.settings, report);
	const after = settings.data;

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
	return { path, report, changed, owned: { approvals: merged.owned, ...(settings.owned ? { settings: settings.owned } : {}) } };
}
