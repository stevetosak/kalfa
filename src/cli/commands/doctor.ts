// `kalfa doctor`: what kalfa sees on this machine and in this repository. Where
// kalfa runs from, the machine settings, the project file and its Plans, the
// Capabilities each harness lacks with what the Core and the Modules do
// without them, and whether the build is up to date. A broken part is
// reported and the next part still runs; only a broken project file stops it.
// `--smoke` runs the clean-state smoke instead (see smoke.ts).
import { existsSync, readFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import type { Adapter } from '../../adapters/adapter.ts';
import { KalfaError } from '../../core/errors.ts';
import type { ModuleDirs } from '../../core/module-dirs.ts';
import { loadModuleSource, MODULE_FILE, moduleFolders, type ModuleManifest } from '../../core/module-source.ts';
import { findPlans, isOpenPlan } from '../../core/plans.ts';
import { AGENTS_FILE, loadProject, type Project, PROJECT_FILE } from '../../core/project.ts';
import { loadSettings, settingsPath } from '../../core/settings.ts';
import { installedSkills, skillRefs } from '../../core/skill-refs.ts';
import { coreNeeds } from '../../modules/core.ts';
import { type Command, parseCommandArgs } from '../command.ts';
import type { Io } from '../io.ts';
import { runSmoke } from '../smoke.ts';
import { version } from '../version.ts';
import { buildProject } from './build.ts';
import { LINKED, linkTarget } from './link.ts';

/** Runs one part; a kalfa error becomes a line instead of stopping the report. */
function part(io: Io, label: string, run: () => string[]): void {
	try {
		const lines = run();
		io.out(lines[0] ? `${label}: ${lines[0]}` : `${label}:`);
		for (const line of lines.slice(1)) io.out(`  ${line}`);
	} catch (error) {
		if (!(error instanceof KalfaError)) throw error;
		io.out(`${label}: problem: ${error.message}`);
	}
}

function installMode(env: NodeJS.ProcessEnv, packageRoot: string): string {
	for (const dir of (env.PATH ?? '').split(delimiter).filter(Boolean)) {
		const path = join(dir, 'kalfa');
		if (!existsSync(path)) continue;
		const target = linkTarget(path);
		if (target === join(packageRoot, 'dist', LINKED.kalfa)) return `linked to this checkout (${path})`;
		return target ? `${path} links to ${target}` : `installed at ${path}`;
	}
	return 'kalfa is not on PATH';
}

function capabilityLines(project: Project | undefined, adapters: ReadonlyMap<string, Adapter>, dirs: readonly string[]): string[] {
	const needs: Array<{ owner: string } & ModuleManifest['needs'][number]> = coreNeeds.map((need) => ({ owner: 'core', ...need }));
	for (const name of project?.file?.modules ?? []) {
		needs.push(...loadModuleSource(dirs, name).manifest.needs.map((need) => ({ owner: name, ...need })));
	}
	const lines: string[] = [];
	for (const adapter of adapters.values()) {
		const off = needs.filter((need) => !adapter.capabilities.has(need.capability));
		lines.push(off.length ? `${adapter.name}: ${off.length} off` : `${adapter.name}: all on`);
		for (const need of off) lines.push(`  ${need.owner} without ${need.capability}: ${need.without}`);
	}
	return ['', ...lines];
}

/** Each Module folder in order, with a missing one and a Module name in two folders flagged. */
function moduleFolderLines(dirs: readonly string[], env: NodeJS.ProcessEnv): string[] {
	const lines = dirs.map((dir, i) => {
		const why = i === 0 ? (env.KALFA_MODULES_DIR ? ' (KALFA_MODULES_DIR)' : ' (the package)') : '';
		return `${dir}${why}${existsSync(dir) ? `: ${moduleFolders([dir]).length} Module(s)` : ': problem: not found'}`;
	});
	const twice = moduleFolders(dirs).filter((name) => dirs.filter((dir) => existsSync(join(dir, name, MODULE_FILE))).length > 1);
	return [`${dirs.length}`, ...lines, ...twice.map((name) => `problem: Module '${name}' is in more than one folder`)];
}

/**
 * Per harness: the skill references in the instruction files it reads that
 * none of its skills answers, without the names `kalfa.yaml` ignores.
 */
function skillRefLines(root: string, env: NodeJS.ProcessEnv, adapters: ReadonlyMap<string, Adapter>, ignored: ReadonlySet<string>): string[] {
	if (!env.HOME) throw new KalfaError('HOME is not set; kalfa cannot find the installed skills');
	const lines: string[] = [];
	for (const adapter of adapters.values()) {
		if (!adapter.skills) continue;
		const known = new Set([...installedSkills(adapter.skills.sources(env.HOME, root)), ...adapter.skills.builtins]);
		const files = [...new Set([AGENTS_FILE, adapter.project?.instructions?.file ?? AGENTS_FILE])].filter((file) => existsSync(join(root, file)));
		const all = files.flatMap((file) => skillRefs(readFileSync(join(root, file), 'utf8')).map((ref) => ({ file, ...ref })));
		const refs = all.filter((ref) => !ignored.has(ref.name));
		const missing = refs.filter((ref) => !known.has(ref.name));
		const skipped = all.length - refs.length ? ` (${all.length - refs.length} ignored)` : '';
		lines.push(`${adapter.name}: ${missing.length ? `${missing.length} of ${refs.length} not found` : `${refs.length} found`}${skipped}`);
		for (const ref of missing) lines.push(`  ${ref.file}:${ref.line}: ${ref.name}`);
		if (missing.length) lines.push(`  (not a skill? add it to skill-refs: {ignore: [...]} in ${PROJECT_FILE})`);
	}
	return ['', ...lines];
}

export function doctorCommand(adapters: ReadonlyMap<string, Adapter>, moduleDirs: ModuleDirs, packageRoot: () => string): Command {
	return {
		summary: 'Report what kalfa sees on this machine and in this repository',
		usage: 'kalfa doctor [--smoke]   (--smoke: install, use and remove this kalfa in a throw-away HOME and repository)',
		async run(args, io) {
			const { values } = parseCommandArgs(args, { smoke: { type: 'boolean' } });
			if (values.smoke) return runSmoke(packageRoot(), io);
			io.out(`kalfa ${version} from ${packageRoot()}`);
			part(io, 'install', () => [installMode(io.env, packageRoot())]);
			const path = settingsPath(io.env);
			part(io, 'machine settings', () => {
				loadSettings(io.env);
				return [`${path}${existsSync(path) ? '' : ' (not found, defaults)'}`];
			});
			part(io, 'Module folders', () => moduleFolderLines(moduleDirs(io.env), io.env));

			const project = loadProject(io.cwd);
			if (!project) {
				io.out('project: none (not in a git repository)');
				return 0;
			}
			io.out(`project: ${project.root}`);
			if (!project.file) io.out(`project file: none (no ${PROJECT_FILE}, Core only)`);
			else {
				const { file } = project;
				io.out(`project file: ${PROJECT_FILE} schema ${file.schema}; Modules: ${file.modules.length ? file.modules.join(', ') : 'none'}`);
				if (file.plans.length) {
					part(io, 'Plans', () => {
						const { plans, problems } = findPlans(project.root, file.plans);
						return [`${plans.length} found, ${plans.filter(isOpenPlan).length} open (${file.plans.join(', ')})`, ...problems.map((p) => `problem: ${p}`)];
					});
				}
			}
			part(io, 'Capabilities', () => capabilityLines(project, adapters, moduleDirs(io.env)));
			part(io, 'skill references', () => skillRefLines(project.root, io.env, adapters, new Set(project.file?.['skill-refs']?.ignore)));
			if (project.file) {
				part(io, 'build', () => {
					const run = buildProject(project, adapters, moduleDirs(io.env), io.env, { dryRun: true, offline: true });
					if (!run.changes) return ['up to date'];
					return [`${run.changes} change(s) waiting; run kalfa build`, ...run.report];
				});
			}
			return 0;
		},
	};
}
