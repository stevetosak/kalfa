import { spawnSync } from 'node:child_process';

/** The checked-out branch at `root`; `undefined` on a detached HEAD or outside git. */
export function currentBranch(root: string): string | undefined {
	const out = spawnSync('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' });
	return out.status === 0 ? out.stdout.trim() : undefined;
}
