// The Module folders, in order: the package's own (or KALFA_MODULES_DIR), then
// the machine setting `module-dirs`. A Module that is not generic lives in its
// own repository, and the Operator names that repository's folder here.
import { homedir } from 'node:os';
import { join } from 'node:path';
import { KalfaError } from './errors.ts';
import { modulesRoot } from './package-root.ts';
import { loadSettings } from './settings.ts';

export type ModuleDirs = (env: NodeJS.ProcessEnv) => string[];

const expandHome = (dir: string, env: NodeJS.ProcessEnv) => (dir.startsWith('~/') ? join(env.HOME || homedir(), dir.slice(2)) : dir);

/** The Module folders; bad machine settings are an error. */
export const moduleDirs: ModuleDirs = (env) => {
	const extra = (loadSettings(env)['module-dirs'] ?? []).map((dir) => expandHome(dir, env));
	return [...new Set([modulesRoot(env), ...extra])];
};

/**
 * The Module folders for the hook path: bad machine settings give only the
 * package's own folder, because the dispatcher reports the settings itself
 * and a hook must not break on them.
 */
export function moduleDirsOrOwn(env: NodeJS.ProcessEnv): string[] {
	try {
		return moduleDirs(env);
	} catch (error) {
		if (error instanceof KalfaError) return [modulesRoot(env)];
		throw error;
	}
}
