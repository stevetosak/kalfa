// `kalfa link` / `unlink`: run kalfa from this checkout. Link puts symlinks to
// the checkout's built `kalfa` and `kalfa-hook` into the user's bin folder, so
// a change is live after `npm run build`; unlink removes only those links.
// `kalfa doctor` shows which mode is on.
import { existsSync, lstatSync, mkdirSync, readlinkSync, rmSync, symlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { KalfaError } from '../../core/errors.ts';
import { type Command, parseCommandArgs } from '../command.ts';

export const LINKED = { kalfa: 'kalfa.mjs', 'kalfa-hook': 'kalfa-hook' } as const;

export function binDir(env: NodeJS.ProcessEnv): string {
	if (env.KALFA_BIN_DIR) return env.KALFA_BIN_DIR;
	if (!env.HOME) throw new KalfaError('HOME is not set; name the bin folder with KALFA_BIN_DIR');
	return join(env.HOME, '.local', 'bin');
}

/** Where the symlink at `path` points, absolute; `undefined` when it is not a symlink. */
export function linkTarget(path: string): string | undefined {
	try {
		if (!lstatSync(path).isSymbolicLink()) return undefined;
	} catch {
		return undefined;
	}
	return resolve(join(path, '..'), readlinkSync(path));
}

export function linkCommand(packageRoot: () => string): Command {
	return {
		summary: "Run kalfa from this checkout: link its built files into the user's bin folder",
		usage: 'kalfa link   (KALFA_BIN_DIR overrides ~/.local/bin)',
		async run(args, io) {
			parseCommandArgs(args, {});
			const dist = join(packageRoot(), 'dist');
			const bin = binDir(io.env);
			const plan = Object.entries(LINKED).map(([name, file]) => ({ path: join(bin, name), target: join(dist, file) }));
			for (const { path, target } of plan) {
				if (!existsSync(target)) throw new KalfaError(`${target} does not exist; run npm run build in ${packageRoot()}`);
				const current = linkTarget(path);
				if (current === undefined && existsSync(path)) throw new KalfaError(`${path} exists and is not a link; remove it first`);
				if (current !== undefined && current !== target) throw new KalfaError(`${path} links to ${current}; run kalfa unlink from that checkout first`);
			}
			mkdirSync(bin, { recursive: true });
			for (const { path, target } of plan) {
				if (linkTarget(path) === target) continue;
				symlinkSync(target, path);
				io.out(`link ${path} → ${target}`);
			}
			io.out(`kalfa runs from ${packageRoot()}`);
			return 0;
		},
	};
}

export function unlinkCommand(packageRoot: () => string): Command {
	return {
		summary: 'Remove the links that kalfa link made to this checkout',
		usage: 'kalfa unlink',
		async run(args, io) {
			parseCommandArgs(args, {});
			const dist = join(packageRoot(), 'dist');
			let removed = 0;
			for (const [name, file] of Object.entries(LINKED)) {
				const path = join(binDir(io.env), name);
				const current = linkTarget(path);
				if (current === undefined) continue;
				if (current !== join(dist, file)) {
					io.err(`kalfa: ${path} links to ${current}, not to this checkout; left in place`);
					continue;
				}
				rmSync(path);
				removed++;
				io.out(`remove ${path}`);
			}
			if (!removed) io.out('no links to this checkout');
			return 0;
		},
	};
}
