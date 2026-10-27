import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The kalfa package folder: from the source (`src/core/`) and from the bundle (`dist/`) alike. */
export function packageRoot(from = fileURLToPath(import.meta.url)): string {
	for (let at = dirname(from); ; at = dirname(at)) {
		if (existsSync(join(at, 'package.json'))) return at;
		if (dirname(at) === at) throw new Error(`no package.json above ${from}`);
	}
}

/** Where the Module folders are: the package's own, or KALFA_MODULES_DIR (Module work and the smoke). */
export const modulesRoot = (env: NodeJS.ProcessEnv = process.env): string => env.KALFA_MODULES_DIR || join(packageRoot(), 'modules');
