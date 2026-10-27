// `kalfa doctor`: what kalfa sees on this machine and in this repository. Where
// kalfa runs from, the machine settings, the project file and its Plans, the
// Capabilities each harness lacks with what the Core and the Modules do
// without them, and whether the build is up to date. A broken part is
// reported and the next part still runs; only a broken project file stops it.
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import type { Adapter } from '../../adapters/adapter.ts';
import { KalfaError } from '../../core/errors.ts';
import { loadModuleSource, type ModuleManifest } from '../../core/module-source.ts';
import { findPlans, isOpenPlan } from '../../core/plans.ts';
import { loadProject, type Project, PROJECT_FILE } from '../../core/project.ts';
import { loadSettings, settingsPath } from '../../core/settings.ts';
import { coreNeeds } from '../../modules/core.ts';
import { type Command, parseCommandArgs } from '../command.ts';
import type { Io } from '../io.ts';
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

function capabilityLines(project: Project | undefined, adapters: ReadonlyMap<string, Adapter>, modulesRoot: string): string[] {
	const needs: Array<{ owner: string } & ModuleManifest['needs'][number]> = coreNeeds.map((need) => ({ owner: 'core', ...need }));
	for (const name of project?.file?.modules ?? []) {
		needs.push(...loadModuleSource(modulesRoot, name).manifest.needs.map((need) => ({ owner: name, ...need })));
	}
	const lines: string[] = [];
	for (const adapter of adapters.values()) {
		const off = needs.filter((need) => !adapter.capabilities.has(need.capability));
		lines.push(off.length ? `${adapter.name}: ${off.length} off` : `${adapter.name}: all on`);
		for (const need of off) lines.push(`  ${need.owner} without ${need.capability}: ${need.without}`);
	}
	return ['', ...lines];
}

export function doctorCommand(adapters: ReadonlyMap<string, Adapter>, modulesRoot: () => string, packageRoot: () => string): Command {
	return {
		summary: 'Report what kalfa sees on this machine and in this repository',
		usage: 'kalfa doctor',
		async run(args, io) {
			parseCommandArgs(args, {});
			io.out(`kalfa ${version} from ${packageRoot()}`);
			part(io, 'install', () => [installMode(io.env, packageRoot())]);
			const path = settingsPath(io.env);
			part(io, 'machine settings', () => {
				loadSettings(io.env);
				return [`${path}${existsSync(path) ? '' : ' (not found, defaults)'}`];
			});

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
			part(io, 'Capabilities', () => capabilityLines(project, adapters, modulesRoot()));
			if (project.file) {
				part(io, 'build', () => {
					const run = buildProject(project, adapters, modulesRoot(), io.env, { dryRun: true, offline: true });
					if (!run.changes) return ['up to date'];
					return [`${run.changes} change(s) waiting; run kalfa build`, ...run.report];
				});
			}
			return 0;
		},
	};
}
