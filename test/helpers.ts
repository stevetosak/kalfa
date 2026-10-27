import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Io } from '../src/cli/io.ts';

export function tempDir(): string {
	return mkdtempSync(join(tmpdir(), 'kalfa-test-'));
}

/** A directory that looks like a repository root (a `.git` folder), with the given files. */
export function tempRepo(files: Record<string, string> = {}): string {
	const root = tempDir();
	mkdirSync(join(root, '.git'));
	for (const [path, text] of Object.entries(files)) {
		mkdirSync(join(root, path, '..'), { recursive: true });
		writeFileSync(join(root, path), text);
	}
	return root;
}

/** A real git repository (for `git check-ignore`), with the given files. */
export function gitRepo(files: Record<string, string> = {}): string {
	const root = tempRepo(files);
	execFileSync('git', ['init', '-q', '--', root]);
	return root;
}

export interface CapturedIo extends Io {
	stdout: string[];
	stderr: string[];
}

export function captureIo(cwd: string, env: NodeJS.ProcessEnv = { HOME: tempDir() }, stdin = ''): CapturedIo {
	const stdout: string[] = [];
	const stderr: string[] = [];
	return { cwd, env, stdout, stderr, stdin: async () => stdin, out: (text) => stdout.push(text), err: (text) => stderr.push(text) };
}
