import { KalfaError } from '../core/errors.ts';
import { isModuleOn } from '../core/modules.ts';
import { loadProject, type Project } from '../core/project.ts';
import { loadSettings } from '../core/settings.ts';
import type { Io } from './io.ts';

/** The project around the working directory; refused outside a repository. */
export function requireProject(io: Io): Project {
	const project = loadProject(io.cwd);
	if (!project) throw new KalfaError('not in a git repository');
	return project;
}

/** A Module's own command runs only where the machine settings or the project file turn the Module on. */
export function requireModule(project: Project | undefined, module: string, env: NodeJS.ProcessEnv): void {
	if (!isModuleOn(module, project, loadSettings(env))) throw new KalfaError(`the ${module} Module is not on here (add it to modules: in kalfa.yaml, or in the machine settings)`);
}
