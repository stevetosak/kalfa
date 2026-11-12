// `kalfa install` / `uninstall`: kalfa's hooks, the status-tap and the machine
// Modules' approvals in the user settings of every harness whose Adapter has
// them, and the instruction file with the Personal layer where a harness has
// one. The hooks and the tap run the built files of the kalfa that installs
// them, so run `kalfa install` again after the package moves.
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { quote } from 'shell-quote';
import type { Adapter } from '../../adapters/adapter.ts';
import { planApprovals } from '../../core/approvals.ts';
import { KalfaError } from '../../core/errors.ts';
import { applyUser, NOTHING, readInstallState, type UserWants, writeInstallState } from '../../core/install.ts';
import { machineCacheDir } from '../../core/machine-paths.ts';
import { personalInstructions } from '../../core/memory/instructions.ts';
import type { ModuleDirs } from '../../core/module-dirs.ts';
import { loadModuleSource } from '../../core/module-source.ts';
import { loadSettings } from '../../core/settings.ts';
import { type Command, parseCommandArgs } from '../command.ts';
import type { Io } from '../io.ts';

function home(env: NodeJS.ProcessEnv): string {
	if (!env.HOME) throw new KalfaError('HOME is not set');
	return env.HOME;
}

function built(path: string): string {
	if (!existsSync(path)) throw new KalfaError(`${path} does not exist; run npm run build`);
	return path;
}

/** What `kalfa install` wants in each harness's user settings; `kalfa doctor` compares the settings with it. */
export function installWants(env: NodeJS.ProcessEnv, moduleDirs: ModuleDirs, packageRoot: string): (adapter: Adapter) => UserWants {
	const settings = loadSettings(env);
	const sources = settings.modules.map((name) => loadModuleSource(moduleDirs(env), name));
	const instructions = personalInstructions(env, settings);
	const shim = quote([built(join(packageRoot, 'dist', 'kalfa-hook'))]);
	return (adapter) => ({
		hook: (event) => `${shim} ${adapter.name} ${event}`,
		tap: quote([built(join(packageRoot, 'dist', 'adapters', adapter.name, 'status-tap'))]),
		approvals: planApprovals(sources, adapter.user!.approvals),
		ownedSettings: true,
		...(adapter.capabilities.has('instruction-file') ? { instructions } : {}),
	});
}

/** The changes `kalfa install` would make in each harness's user settings, without writing them. */
export function pendingInstall(adapters: ReadonlyMap<string, Adapter>, env: NodeJS.ProcessEnv, wants: (adapter: Adapter) => UserWants): Array<{ harness: string; changes: string[] }> {
	const state = readInstallState(env);
	return [...adapters.values()]
		.filter((adapter) => adapter.user)
		.map((adapter) => {
			const result = applyUser(home(env), adapter.user!, wants(adapter), state.harnesses[adapter.name], { dryRun: true });
			return { harness: adapter.name, changes: result.changed ? result.report : [] };
		});
}

/**
 * Runs `wants` for every harness with user settings: first as a dry run for
 * all of them, so a problem in one writes nothing anywhere, then for real.
 */
function run(adapters: ReadonlyMap<string, Adapter>, io: Io, wants: (adapter: Adapter) => UserWants, dryRun: boolean, remove: boolean): number {
	const state = readInstallState(io.env);
	const users = [...adapters.values()].filter((adapter) => adapter.user);
	for (const adapter of users) applyUser(home(io.env), adapter.user!, wants(adapter), state.harnesses[adapter.name], { dryRun: true });
	for (const adapter of users) {
		const result = applyUser(home(io.env), adapter.user!, wants(adapter), state.harnesses[adapter.name], { dryRun });
		io.out(`${adapter.name}: ${result.path}`);
		for (const line of result.report) io.out(`  ${line}`);
		if (remove) delete state.harnesses[adapter.name];
		else state.harnesses[adapter.name] = result.owned;
	}
	if (!users.length) io.out('no harness has user settings kalfa can write');
	if (dryRun) io.out('dry run: nothing was written');
	else writeInstallState(io.env, state);
	return 0;
}

export function installCommand(adapters: ReadonlyMap<string, Adapter>, moduleDirs: ModuleDirs, packageRoot: () => string): Command {
	return {
		summary: "Write kalfa's hooks, the status-line tap, the machine Modules' approvals and the Personal layer's instruction file into the harnesses' user settings, and set the settings kalfa owns (their own memory off, idle compaction)",
		usage: 'kalfa install [--dry-run]',
		async run(args, io) {
			const { values } = parseCommandArgs(args, { 'dry-run': { type: 'boolean' } });
			return run(adapters, io, installWants(io.env, moduleDirs, packageRoot()), values['dry-run'] ?? false, false);
		},
	};
}

export function uninstallCommand(adapters: ReadonlyMap<string, Adapter>): Command {
	return {
		summary: "Remove what kalfa install wrote, and kalfa's cache; the Operator's own entries stay",
		usage: 'kalfa uninstall [--dry-run]',
		async run(args, io) {
			const { values } = parseCommandArgs(args, { 'dry-run': { type: 'boolean' } });
			const dryRun = values['dry-run'] ?? false;
			const code = run(adapters, io, () => NOTHING, dryRun, true);
			// Everything in the cache folder is written again on use (event table, usage limits, pinned skills).
			const cache = machineCacheDir(io.env);
			if (existsSync(cache)) {
				io.out(`remove ${cache} (kalfa's cache)`);
				if (!dryRun) rmSync(cache, { recursive: true, force: true });
			}
			return code;
		},
	};
}
