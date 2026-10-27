import { KalfaError } from '../core/errors.ts';
import { loadProject, type Project } from '../core/project.ts';
import type { Io } from './io.ts';

/** The project around the working directory; refused outside a repository. */
export function requireProject(io: Io): Project {
	const project = loadProject(io.cwd);
	if (!project) throw new KalfaError('not in a git repository');
	return project;
}

/** A Module's own command runs only where the project file turns the Module on. */
export function requireModule(project: Project, module: string): void {
	if (!project.file?.modules.includes(module)) throw new KalfaError(`the ${module} Module is not on in this repository (add it to modules: in kalfa.yaml)`);
}
