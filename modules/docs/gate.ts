// The Definition of Done that a program can judge from a branch: a Log for
// the work was added or changed. A Log is a file under one of the `logs`
// globs of `kalfa.yaml`. What a Log must say, and which other pages the work
// made stale, need judgement; the agent and the site's own checks handle them.
// The files come from git, base...head, so the gate judges what the PR will
// hold, not the working tree.
import { spawnSync } from 'node:child_process';
import picomatch from 'picomatch';
import { KalfaError } from '../../src/core/errors.ts';

export interface Change {
	path: string;
	/** git's status letter: A, M, D, R, C, T. */
	status: string;
}

export type Verdict = { ok: true; logs: string[] } | { ok: false; problem: string };

function git(dir: string, args: string[]): string {
	const out = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
	if (out.status !== 0) throw new KalfaError(`git ${args.join(' ')}: ${(out.stderr || out.error?.message || 'failed').trim()}`);
	return out.stdout;
}

const refExists = (dir: string, ref: string) => spawnSync('git', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { cwd: dir }).status === 0;

/** `name` as a local ref if it exists, else `origin/name`; the other way round with `preferRemote`. */
export function resolveRef(dir: string, name: string, preferRemote = false): string {
	const order = preferRemote ? [`origin/${name}`, name] : [name, `origin/${name}`];
	const found = order.find((ref) => refExists(dir, ref));
	if (!found) throw new KalfaError(`git has no ref "${name}" or "origin/${name}"`);
	return found;
}

/** The branch `origin/HEAD` points at, else `main`. */
export function defaultBranch(dir: string): string {
	const out = spawnSync('git', ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], { cwd: dir, encoding: 'utf8' });
	return out.status === 0 ? out.stdout.trim().replace(/^origin\//, '') : 'main';
}

/** Each changed file, base...head (from their merge base). */
export function branchChanges(dir: string, baseRef: string, headRef: string): Change[] {
	const fields = git(dir, ['diff', '--name-status', '-z', `${baseRef}...${headRef}`]).split('\0').filter(Boolean);
	const changes: Change[] = [];
	for (let i = 0; i < fields.length; ) {
		const status = fields[i]![0]!;
		// R and C carry two paths (old, new); keep the new one.
		const paths = status === 'R' || status === 'C' ? 2 : 1;
		changes.push({ status, path: fields[i + paths]! });
		i += 1 + paths;
	}
	return changes;
}

/** A deleted Log is not a Log for this work. */
export function judge(changes: Change[], logGlobs: readonly string[]): Verdict {
	const isLog = picomatch([...logGlobs]);
	const logs = changes.filter((c) => c.status !== 'D' && isLog(c.path)).map((c) => c.path);
	if (logs.length) return { ok: true, logs };
	return { ok: false, problem: `no Log was added or changed (a Log is a file under ${logGlobs.join(', ')})` };
}

export interface BranchCheck {
	/** A directory in the work tree the PR is made from. */
	dir: string;
	logGlobs: readonly string[];
	/** The base branch name; the remote one is preferred, as the PR merges into it. */
	base: string;
	/** The head branch name; the work tree's HEAD when not given. */
	head?: string;
}

export function checkBranch({ dir, logGlobs, base, head }: BranchCheck): Verdict & { range: string } {
	const baseRef = resolveRef(dir, base, true);
	const headRef = head ? resolveRef(dir, head) : 'HEAD';
	return { ...judge(branchChanges(dir, baseRef, headRef), logGlobs), range: `${baseRef}...${headRef}` };
}

/** `owner/name` of the `origin` remote, if it is a GitHub-style URL. */
export function originRepo(dir: string): string | undefined {
	const out = spawnSync('git', ['remote', 'get-url', 'origin'], { cwd: dir, encoding: 'utf8' });
	if (out.status !== 0) return undefined;
	return /[:/]([^/:]+\/[^/]+?)(?:\.git)?\/?$/.exec(out.stdout.trim())?.[1];
}
