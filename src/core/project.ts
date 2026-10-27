// The project a session works in: the repository root and its committed
// project file. A repository without `kalfa.yaml` gets the Core alone.
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { readVersioned, type VersionedFormat } from './versioned-file.ts';

export const PROJECT_FILE = 'kalfa.yaml';
/** The instruction file every harness can read (some only through an import). */
export const AGENTS_FILE = 'AGENTS.md';

const moduleName = z.string().regex(/^[a-z][a-z0-9-]*$/, 'a Module name is lower-case letters, digits and dashes');

// A glob relative to the repository root that cannot leave it.
const repoGlob = z
	.string()
	.min(1)
	.refine((glob) => !glob.startsWith('/') && !glob.split('/').includes('..'), 'a glob is relative to the repository root and stays inside it');

const projectFileSchema = z.strictObject({
	schema: z.literal(1),
	modules: z
		.array(moduleName)
		.default([])
		.refine((names) => new Set(names).size === names.length, 'a Module is listed twice'),
	/** Where the Plans are: globs over Markdown files; only pages with `type: plan` count. */
	plans: z.array(repoGlob).default([]),
});

export type ProjectFile = z.infer<typeof projectFileSchema>;

export const projectFileFormat: VersionedFormat<ProjectFile> = {
	name: PROJECT_FILE,
	current: 1,
	schema: projectFileSchema,
};

export interface Project {
	root: string;
	/** `undefined` when the repository has no project file. */
	file: ProjectFile | undefined;
}

/** The nearest directory at or above `dir` that holds `.git` (a folder, or a file in a work tree). */
export function repoRootOf(dir: string): string | undefined {
	for (let at = dir; ; at = dirname(at)) {
		if (existsSync(join(at, '.git'))) return at;
		if (dirname(at) === at) return undefined;
	}
}

/** The project around `cwd`; `undefined` outside a repository. */
export function loadProject(cwd: string): Project | undefined {
	const root = repoRootOf(cwd);
	if (!root) return undefined;
	return { root, file: readVersioned(join(root, PROJECT_FILE), projectFileFormat) };
}
