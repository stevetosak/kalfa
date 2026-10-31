// `kalfa build`: writes the files of the Modules that `kalfa.yaml` turns on, for
// every harness whose Adapter has a project layout. With no Modules left on, it
// removes what it wrote before.
import type { Adapter } from '../../adapters/adapter.ts';
import { applyHarness, type BuildOptions, type BuildState, planHarness, readBuildState, readTree, type SkillBundle, writeBuildState } from '../../core/build.ts';
import { KalfaError } from '../../core/errors.ts';
import type { ModuleDirs } from '../../core/module-dirs.ts';
import { loadModuleSource, type ModuleSource } from '../../core/module-source.ts';
import { isPrivateDirIgnored, PRIVATE_DIR } from '../../core/private-dir.ts';
import { type Project, PROJECT_FILE } from '../../core/project.ts';
import { cacheRoot, composeThirdParty } from '../../core/third-party.ts';
import { type Command, parseCommandArgs } from '../command.ts';
import { requireProject } from '../project.ts';

/**
 * Every Module's skills, its own and the pinned third-party ones, composed
 * once for all harnesses. A pinned skill whose cached content no longer
 * matches the hash recorded for the same pin is refused.
 */
function composeSkills(sources: ModuleSource[], cache: string, previous: BuildState, offline: boolean, report: string[]) {
	const skills = new Map<string, SkillBundle[]>();
	const pins: BuildState['pins'] = {};
	for (const source of sources) {
		const bundles = source.skills.map((skill) => ({ name: skill.name, files: readTree(skill.dir) }));
		for (const pin of source.manifest['third-party']) {
			const { bundle, sha256 } = composeThirdParty(source, pin, cache, offline);
			const before = previous.pins[pin.name];
			const samePin = before?.source === pin.source && before.path === pin.path && before.commit === pin.commit;
			if (samePin && before.sha256 !== sha256) {
				throw new KalfaError(`${pin.name}: the cached copy of ${pin.source} at ${pin.commit.slice(0, 12)} differs from the hash kalfa recorded; remove the cache folder ${cache} and build again`);
			}
			if (before && !samePin) report.push(`pin ${pin.name}: ${before.commit.slice(0, 12)} → ${pin.commit.slice(0, 12)}`);
			if (!before) report.push(`pin ${pin.name}: ${pin.source} ${pin.path} at ${pin.commit.slice(0, 12)}`);
			pins[pin.name] = { source: pin.source, path: pin.path, commit: pin.commit, sha256 };
			bundles.push(bundle);
		}
		skills.set(source.name, bundles);
	}
	return { skills, pins };
}

export interface BuildRun {
	/** For the Operator: pin changes, then per harness its changes. */
	report: string[];
	/** Changes counted over all harnesses (unchanged files are not changes). */
	changes: number;
	state: BuildState;
}

/** Plans, checks and (unless a dry run) writes the build of `project`. */
export function buildProject(
	project: Project,
	adapters: ReadonlyMap<string, Adapter>,
	moduleDirs: readonly string[],
	env: NodeJS.ProcessEnv,
	options: BuildOptions & { offline?: boolean } = {},
): BuildRun {
	if (!project.file) throw new KalfaError(`no ${PROJECT_FILE} in ${project.root}; run kalfa init`);
	if (!isPrivateDirIgnored(project.root)) throw new KalfaError(`git does not ignore ${PRIVATE_DIR}/, where kalfa records what it wrote; add \`${PRIVATE_DIR}/\` to .gitignore`);

	const sources = project.file.modules.map((name) => loadModuleSource(moduleDirs, name));
	const previous = readBuildState(project.root);
	const report: string[] = [];
	const { skills, pins } = composeSkills(sources, cacheRoot(env), previous, options.offline ?? false, report);
	let changes = report.length;

	const state: BuildState = { schema: 1, harnesses: { ...previous.harnesses }, pins };
	for (const adapter of adapters.values()) {
		if (!adapter.project) continue;
		const planned = planHarness(sources, adapter.project, (source) => skills.get(source.name) ?? []);
		const result = applyHarness(project.root, adapter.project, planned, previous.harnesses[adapter.name], options);
		const lines = result.report.filter((line) => !line.endsWith('unchanged'));
		changes += lines.length;
		report.push(`${adapter.name}:`, ...(result.report.length ? result.report : ['nothing to write']).map((line) => `  ${line}`));
		state.harnesses[adapter.name] = result.state;
	}
	if (!options.dryRun) writeBuildState(project.root, state);
	return { report, changes, state };
}

export function buildCommand(adapters: ReadonlyMap<string, Adapter>, moduleDirs: ModuleDirs): Command {
	return {
		summary: "Write the enabled Modules' skills, rules and approvals into this repository",
		usage: 'kalfa build [--dry-run] [--force]',
		async run(args, io) {
			const { values } = parseCommandArgs(args, { 'dry-run': { type: 'boolean' }, force: { type: 'boolean' } });
			const run = buildProject(requireProject(io), adapters, moduleDirs(io.env), io.env, { dryRun: values['dry-run'], force: values.force });
			for (const line of run.report) io.out(line);
			if (values['dry-run']) io.out('dry run: nothing was written');
			return 0;
		},
	};
}
