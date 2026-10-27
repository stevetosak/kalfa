// `kalfa build`: writes the files of the Modules that `kalfa.yaml` turns on, for
// every harness whose Adapter has a project layout. With no Modules left on, it
// removes what it wrote before.
import type { Adapter } from '../../adapters/adapter.ts';
import { applyHarness, planHarness, readBuildState, readTree, type SkillBundle, writeBuildState } from '../../core/build.ts';
import { KalfaError } from '../../core/errors.ts';
import { loadModuleSource, type ModuleSource } from '../../core/module-source.ts';
import { isPrivateDirIgnored, PRIVATE_DIR } from '../../core/private-dir.ts';
import { PROJECT_FILE } from '../../core/project.ts';
import { type Command, parseCommandArgs } from '../command.ts';
import { requireProject } from '../project.ts';

/** A Module's own skills, read from its folder. */
const ownSkills = (source: ModuleSource): SkillBundle[] => source.skills.map((skill) => ({ name: skill.name, files: readTree(skill.dir) }));

export function buildCommand(adapters: ReadonlyMap<string, Adapter>, modulesRoot: () => string): Command {
	return {
		summary: "Write the enabled Modules' skills, rules and approvals into this repository",
		usage: 'kalfa build [--dry-run] [--force]',
		async run(args, io) {
			const { values } = parseCommandArgs(args, { 'dry-run': { type: 'boolean' }, force: { type: 'boolean' } });
			const project = requireProject(io);
			if (!project.file) throw new KalfaError(`no ${PROJECT_FILE} in ${project.root}; run kalfa init`);
			if (!isPrivateDirIgnored(project.root)) throw new KalfaError(`git does not ignore ${PRIVATE_DIR}/, where kalfa records what it wrote; add \`${PRIVATE_DIR}/\` to .gitignore`);

			const sources = project.file.modules.map((name) => loadModuleSource(modulesRoot(), name));
			const previous = readBuildState(project.root);
			const state = { schema: 1 as const, harnesses: { ...previous.harnesses } };
			const options = { dryRun: values['dry-run'], force: values.force };
			for (const adapter of adapters.values()) {
				if (!adapter.project) continue;
				const planned = planHarness(sources, adapter.project, ownSkills);
				const result = applyHarness(project.root, adapter.project, planned, previous.harnesses[adapter.name], options);
				io.out(`${adapter.name}:`);
				for (const line of result.report.length ? result.report : ['nothing to write']) io.out(`  ${line}`);
				state.harnesses[adapter.name] = result.state;
			}
			if (values['dry-run']) io.out('dry run: nothing was written');
			else writeBuildState(project.root, state);
			return 0;
		},
	};
}
