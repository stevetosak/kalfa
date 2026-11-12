import { spawnSync } from 'node:child_process';

/** The checked-out branch at `root`; `undefined` on a detached HEAD or outside git. */
export function currentBranch(root: string): string | undefined {
	const out = spawnSync('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' });
	return out.status === 0 ? out.stdout.trim() : undefined;
}

const git = (root: string, args: string[]) => spawnSync('git', args, { cwd: root, encoding: 'utf8' });

/** The commit time of HEAD; `undefined` outside git or before the first commit. */
export function headTime(root: string): Date | undefined {
	const out = git(root, ['log', '-1', '--format=%cI']);
	const time = out.status === 0 ? out.stdout.trim() : '';
	return time ? new Date(time) : undefined;
}

/** The commits on HEAD after `since`, newest first, as `<short hash> <subject>`; at most `max`, and how many more there are. */
export function commitsSince(root: string, since: Date, max: number): { lines: string[]; more: number } {
	// `--after` keeps a commit of the same second; the strict test on %ct drops it.
	const out = git(root, ['log', `--after=${since.toISOString()}`, '--format=%ct %h %s']);
	const all = (out.status === 0 ? out.stdout.split('\n').filter(Boolean) : [])
		.filter((line) => Number(line.slice(0, line.indexOf(' '))) * 1000 > since.getTime())
		.map((line) => line.slice(line.indexOf(' ') + 1));
	return { lines: all.slice(0, max), more: Math.max(0, all.length - max) };
}
