// The push rule: no push lands on a protected branch, whatever the form. The
// command line is split into simple commands; `cd` and `git -C` move the
// folder the next git runs in, so a push without a refspec is judged on the
// branch checked out there and on its upstream.
import { spawnSync } from 'node:child_process';
import { basename, resolve } from 'node:path';
import { parse } from 'shell-quote';

/** Operators that end a simple command. */
const SEPARATORS = new Set(['&&', '||', ';', ';;', '|', '|&', '&', '(', ')']);
/** Words before a command that only change how it runs. */
const PREFIXES = new Set(['command', 'env', 'nohup', 'sudo', 'time', 'exec']);
/** git options before the subcommand that take the next word as their value. */
const GIT_VALUE_OPTIONS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env', '--super-prefix']);
/** `git push` options that take the next word as their value. */
const PUSH_VALUE_OPTIONS = new Set(['-o', '--push-option', '--repo', '--receive-pack', '--exec']);

/** Reads git in `dir`; `undefined` when git cannot answer. */
export type GitRead = (dir: string, args: string[]) => string | undefined;

export const readGit: GitRead = (dir, args) => {
	const out = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
	return out.status === 0 ? out.stdout.trim() : undefined;
};

/** The simple commands of a command line, as words; variables stay as written. */
export function simpleCommands(line: string): string[][] {
	const commands: string[][] = [[]];
	for (const token of parse(line, (name) => `$${name}`)) {
		if (typeof token === 'string') commands.at(-1)!.push(token);
		else if ('op' in token && SEPARATORS.has(token.op)) commands.push([]);
		else if ('op' in token && token.op === 'glob') commands.at(-1)!.push(token.pattern);
	}
	return commands.filter((words) => words.length);
}

const stripPrefixes = (words: string[]): string[] => {
	let at = 0;
	while (at < words.length && (PREFIXES.has(words[at]!) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[at]!))) at++;
	return words.slice(at);
};

interface Push {
	dir: string;
	options: Set<string>;
	/** The remote and the refspecs, in order. */
	args: string[];
}

/** A `git … push …` call and the folder it runs in; `undefined` for any other command. */
function pushOf(words: string[], cwd: string): Push | undefined {
	if (basename(words[0] ?? '') !== 'git') return undefined;
	let dir = cwd;
	let at = 1;
	for (; at < words.length && words[at]!.startsWith('-'); at++) {
		const word = words[at]!;
		if (word === '-C') dir = resolve(dir, words[at + 1] ?? '.');
		if (GIT_VALUE_OPTIONS.has(word)) at++;
	}
	if (words[at] !== 'push') return undefined;
	const options = new Set<string>();
	const args: string[] = [];
	for (let i = at + 1; i < words.length; i++) {
		const word = words[i]!;
		if (word === '--') args.push(...words.slice(i + 1));
		if (word === '--') break;
		if (!word.startsWith('-')) args.push(word);
		else {
			options.add(word.split('=')[0]!);
			if (PUSH_VALUE_OPTIONS.has(word)) i++;
		}
	}
	return { dir, options, args };
}

/** The branch a refspec writes to; `HEAD` stands for the branch checked out. */
function destination(refspec: string, deleting: boolean): string {
	const spec = refspec.replace(/^\+/, '');
	const dst = deleting || !spec.includes(':') ? spec : spec.slice(spec.lastIndexOf(':') + 1);
	return dst.replace(/^refs\/heads\//, '');
}

function refusals(push: Push, protectedBranches: string[], git: GitRead): string[] {
	const { options, args, dir } = push;
	if (options.has('-n') || options.has('--dry-run')) return [];
	if (options.has('--all') || options.has('--branches') || options.has('--mirror')) return [`a push of every branch includes ${protectedBranches.join(' and ')}`];
	const current = () => git(dir, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
	const refspecs = args.slice(1);
	const targets: string[] = [];
	if (!refspecs.length) {
		const branch = current();
		const upstream = git(dir, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']);
		if (branch) targets.push(branch);
		if (upstream) targets.push(upstream.slice(upstream.indexOf('/') + 1));
	}
	const deleting = options.has('-d') || options.has('--delete');
	for (const refspec of refspecs) {
		const dst = destination(refspec, deleting);
		if (dst.includes('$')) return [`the push target '${refspec}' is a variable; name the branch so the rule can check it`];
		targets.push(dst === 'HEAD' || dst === '@' ? (current() ?? dst) : dst);
	}
	return [...new Set(targets.filter((target) => protectedBranches.includes(target)))].map((target) => `a push to the protected branch '${target}'`);
}

/** Why the command line pushes to a protected branch; empty when it does not. */
export function protectedPushes(line: string, cwd: string, protectedBranches: string[], git: GitRead = readGit): string[] {
	const reasons: string[] = [];
	let dir = cwd;
	for (const command of simpleCommands(line)) {
		const words = stripPrefixes(command);
		if (words[0] === 'cd') dir = resolve(dir, words[1] ?? process.env.HOME ?? '/');
		const push = pushOf(words, dir);
		if (push) reasons.push(...refusals(push, protectedBranches, git).map((reason) => `${reason} (${command.join(' ')})`));
	}
	return reasons;
}
