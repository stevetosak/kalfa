import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Io } from '../src/cli/io.ts';
import { type Layer, memoryHome, writeRecords } from '../src/core/memory/home.ts';
import type { RecordStatus, RecordType } from '../src/core/memory/record.ts';

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

/**
 * A record as an older kalfa wrote it (a rule record, or a proposed one),
 * written straight into the Memory home and committed: no write command makes
 * one now (ADR 0003), but the migration still reads them.
 */
export function legacyRecord(env: NodeJS.ProcessEnv, layer: Layer, id: string, header: { type: RecordType; summary: string; status?: RecordStatus }): void {
	const record = { id, header: { schema: 1 as const, status: 'active' as const, created: '2026-11-01', confirmed: '2026-11-01', ...header }, body: '' };
	writeRecords(memoryHome(env), [{ layer, record }], `legacy ${header.type} ${id} (${layer.label})`);
}
