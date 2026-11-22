// `kalfa install` / `uninstall`: kalfa's hooks, the status-tap and the machine
// Modules' approvals in the user settings of every harness whose Adapter has
// them, and the instruction file with the Personal layer where a harness has
// one. The hooks and the tap run the built files of the kalfa that installs
// them, so run `kalfa install` again after the package moves. A Module can
// have its own part on the machine (a MachineStep, such as the herdr Module's
// Herdr plugin); it runs after the settings, and install.yaml records it so
// uninstall, or an install with the Module off, undoes only what install did.
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { quote } from 'shell-quote';
import type { Adapter } from '../../adapters/adapter.ts';
import { planApprovals } from '../../core/approvals.ts';
import { KalfaError } from '../../core/errors.ts';
import { applyUser, type InstallState, NOTHING, readInstallState, type UserWants, writeInstallState } from '../../core/install.ts';
import type { MachineStep } from '../../core/machine-step.ts';
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
export function installWants(env: NodeJS.ProcessEnv, moduleDirs: ModuleDirs, packageRoot: string, steps: ReadonlyMap<string, MachineStep> = new Map()): (adapter: Adapter) => UserWants {
	const settings = loadSettings(env);
	const sources = settings.modules.map((name) => loadModuleSource(moduleDirs(env), name));
	const instructions = personalInstructions(env, settings);
	const shim = quote([built(join(packageRoot, 'dist', 'kalfa-hook'))]);
	const agentEnv = Object.assign(
		{},
		...sources.map((source) => steps.get(source.name)?.agentEnv?.({ env, moduleDir: source.dir, dryRun: true }) ?? {}),
	) as Record<string, string>;
	return (adapter) => ({
		hook: (event) => `${shim} ${adapter.name} ${event}`,
		tap: quote([built(join(packageRoot, 'dist', 'adapters', adapter.name, 'status-tap'))]),
		approvals: planApprovals(sources, adapter.user!.approvals),
		ownedSettings: true,
		agentEnv,
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

/** The Modules' own steps, and the Modules whose step install wants. */
interface MachineWants {
	steps: ReadonlyMap<string, MachineStep>;
	moduleDirs: ModuleDirs;
	want: readonly string[];
}

/**
 * Installs the step of each Module in `want`, and undoes a step install ran
 * before whose Module is no longer wanted; `state.steps` follows. A step that
 * fails is reported, stays recorded, and the others still run; the exit code
 * says so.
 */
function applySteps(machine: MachineWants, state: InstallState, io: Io, dryRun: boolean): number {
	let code = 0;
	for (const [name, step] of machine.steps) {
		const install = machine.want.includes(name);
		if (!install && !state.steps.includes(name)) continue;
		io.out(`${name} Module:`);
		const recorded = new Set(state.steps).add(name);
		try {
			const context = { env: io.env, moduleDir: loadModuleSource(machine.moduleDirs(io.env), name).dir, dryRun };
			for (const line of install ? step.install(context) : step.uninstall(context)) io.out(`  ${line}`);
			if (!install) recorded.delete(name);
		} catch (error) {
			const { stderr, message } = error as { stderr?: string | Buffer; message?: string };
			io.err(`kalfa: the ${name} Module's step failed: ${String(stderr || message || error).trim()}`);
			code = 1;
		}
		state.steps = [...recorded];
	}
	return code;
}

/**
 * Runs `wants` for every harness with user settings: first as a dry run for
 * all of them, so a problem in one writes nothing anywhere, then for real.
 * The Modules' steps run after the settings.
 */
function run(adapters: ReadonlyMap<string, Adapter>, io: Io, wants: (adapter: Adapter) => UserWants, machine: MachineWants, dryRun: boolean, remove: boolean): number {
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
	const code = applySteps(machine, state, io, dryRun);
	if (dryRun) io.out('dry run: nothing was written');
	else writeInstallState(io.env, state);
	return code;
}

export function installCommand(adapters: ReadonlyMap<string, Adapter>, moduleDirs: ModuleDirs, packageRoot: () => string, steps: ReadonlyMap<string, MachineStep> = new Map()): Command {
	return {
		summary: "Write kalfa's hooks, the status-line tap, the machine Modules' approvals and the Personal layer's instruction file into the harnesses' user settings, set the settings kalfa owns (their own memory off, idle compaction), and run the machine Modules' own steps (the herdr Module links its Herdr plugin and binds its action to a Herdr key)",
		usage: 'kalfa install [--dry-run]',
		async run(args, io) {
			const { values } = parseCommandArgs(args, { 'dry-run': { type: 'boolean' } });
			const dryRun = values['dry-run'] ?? false;
			const machine = { steps, moduleDirs, want: loadSettings(io.env).modules };
			return run(adapters, io, installWants(io.env, moduleDirs, packageRoot(), steps), machine, dryRun, false);
		},
	};
}

export function uninstallCommand(adapters: ReadonlyMap<string, Adapter>, moduleDirs: ModuleDirs, steps: ReadonlyMap<string, MachineStep> = new Map()): Command {
	return {
		summary: "Remove what kalfa install wrote, with what the Modules' own steps set up, and kalfa's cache; the Operator's own entries stay",
		usage: 'kalfa uninstall [--dry-run]',
		async run(args, io) {
			const { values } = parseCommandArgs(args, { 'dry-run': { type: 'boolean' } });
			const dryRun = values['dry-run'] ?? false;
			const code = run(adapters, io, () => NOTHING, { steps, moduleDirs, want: [] }, dryRun, true);
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
