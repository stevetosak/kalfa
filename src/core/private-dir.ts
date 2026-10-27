// `<repo>/.kalfa/` holds the Task Record, the project layer and generated
// state. The repositories are public, so kalfa writes there only when git
// ignores the folder.
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { KalfaError } from './errors.ts';

export const PRIVATE_DIR = '.kalfa';

export function isPrivateDirIgnored(root: string): boolean {
	const check = spawnSync('git', ['check-ignore', '-q', `${PRIVATE_DIR}/`], { cwd: root, stdio: 'ignore' });
	if (check.status === 0) return true;
	if (check.status === 1) return false;
	throw new KalfaError(`${root}: git check-ignore failed (status ${check.status ?? check.signal})`);
}

/** The private folder of the repository at `root`, created on demand; refused unless git ignores it. */
export function privateDir(root: string): string {
	if (!isPrivateDirIgnored(root)) {
		throw new KalfaError(`refusing to write ${join(root, PRIVATE_DIR)}/: git does not ignore it; add \`${PRIVATE_DIR}/\` to .gitignore`);
	}
	const dir = join(root, PRIVATE_DIR);
	mkdirSync(dir, { recursive: true });
	return dir;
}
