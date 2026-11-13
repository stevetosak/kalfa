// `<repo>/.kalfa/` holds the Task Records, the Checkpoints and generated
// state. The repositories are public, so kalfa writes there only when git
// ignores the folder. A worktree is a second checkout of one repository: the
// repository's state (Task Records, Checkpoints, the session stamp) lives in
// the main checkout, so every checkout sees all Tasks; what the hook shim
// reads (the event table, the wake markers) stays in each checkout, where the
// shim looks.
import { spawnSync } from 'node:child_process';
import { mkdirSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
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

const mains = new Map<string, string>();

/**
 * The main checkout of the repository at `root`: `root` itself, or for a
 * worktree the checkout its `.git` file points back to. A `.git` file that is
 * not a worktree's (a submodule's) keeps `root`.
 */
export function mainCheckout(root: string): string {
	let main = mains.get(root);
	if (main === undefined) {
		main = root;
		if (statSync(join(root, '.git'), { throwIfNoEntry: false })?.isFile()) {
			const common = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root, encoding: 'utf8' }).stdout?.trim();
			if (common && basename(common) === '.git') main = dirname(common);
		}
		mains.set(root, main);
	}
	return main;
}

/** A path in the repository's state, shared by every checkout of it. */
export function statePath(root: string, ...parts: string[]): string {
	return join(mainCheckout(root), PRIVATE_DIR, ...parts);
}

/** The private folder that holds the repository's state, created on demand; refused unless git ignores it. */
export function stateDir(root: string): string {
	return privateDir(mainCheckout(root));
}
