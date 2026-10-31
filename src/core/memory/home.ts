// The Memory home: one private folder outside every repository, with its own
// git history (ADR 0002). `personal/` is the Personal layer; each project's
// layer is `projects/<host>/<owner>/<repo>/`, keyed by its `origin` URL, so
// every work tree and clone of a repository shares it.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { KalfaError } from '../errors.ts';
import { machineDataDir } from '../machine-paths.ts';
import type { Project } from '../project.ts';
import { type MemoryRecord, parseMemoryRecord, renderMemoryRecord } from './record.ts';

export type LayerName = 'personal' | 'project';

export interface Layer {
	name: LayerName;
	/** The folder of its records. */
	dir: string;
	/** How messages name it: `personal`, or the project key. */
	label: string;
}

export function memoryHome(env: NodeJS.ProcessEnv = process.env): string {
	return join(machineDataDir(env), 'memory');
}

/** `host/owner/repo` from a git remote URL (scp-like, ssh://, https://); `undefined` when it has no such shape. */
export function keyFromRemote(url: string): string | undefined {
	let host: string | undefined;
	let path: string | undefined;
	const scp = /^(?:[^@/:]+@)?([^:/]+):(?!\/)(.+)$/.exec(url);
	if (scp && !/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
		[, host, path] = scp;
	} else {
		try {
			const parsed = new URL(url);
			host = parsed.hostname;
			path = parsed.pathname;
		} catch {
			return undefined;
		}
	}
	const segments = (path ?? '')
		.replace(/\.git\/?$/, '')
		.split('/')
		.filter(Boolean)
		.map((s) => s.toLowerCase());
	if (!host || segments.length < 2 || segments.some((s) => s === '.' || s === '..' || !/^[a-z0-9._-]+$/.test(s))) return undefined;
	return [host.toLowerCase(), ...segments].join('/');
}

/** The key of a project's layer: from its `origin` remote, else `local/<folder name>`. */
export function projectKey(root: string): string {
	const out = spawnSync('git', ['remote', 'get-url', 'origin'], { cwd: root, encoding: 'utf8' });
	const key = out.status === 0 ? keyFromRemote(out.stdout.trim()) : undefined;
	return key ?? `local/${basename(root).toLowerCase().replace(/[^a-z0-9._-]+/g, '-')}`;
}

export function personalLayer(home: string): Layer {
	return { name: 'personal', dir: join(home, 'personal'), label: 'personal' };
}

export function projectLayer(home: string, project: Project): Layer {
	const key = projectKey(project.root);
	return { name: 'project', dir: join(home, 'projects', ...key.split('/')), label: key };
}

/** The layers a session in `project` sees: the Personal layer, and the project's when there is one. */
export function sessionLayers(home: string, project: Project | undefined): Layer[] {
	return project ? [personalLayer(home), projectLayer(home, project)] : [personalLayer(home)];
}

export function recordPath(layer: Layer, id: string): string {
	return join(layer.dir, `${id}.md`);
}

export function readLayer(layer: Layer): MemoryRecord[] {
	if (!existsSync(layer.dir)) return [];
	return readdirSync(layer.dir)
		.filter((name) => name.endsWith('.md'))
		.sort()
		.map((name) => parseMemoryRecord(readFileSync(join(layer.dir, name), 'utf8'), join(layer.dir, name), name.slice(0, -3)));
}

// The home's git runs with no hooks, no signing and its own identity, so a
// write never waits on a prompt or on the Operator's global git settings.
const GIT_CONFIG = ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-c', 'user.name=kalfa', '-c', 'user.email=kalfa@localhost'];

function git(home: string, args: string[]): string {
	const out = spawnSync('git', [...GIT_CONFIG, ...args], { cwd: home, encoding: 'utf8' });
	if (out.status !== 0) throw new KalfaError(`Memory home: git ${args[0]} failed: ${(out.stderr || out.error?.message || '').trim()}`);
	return out.stdout;
}

/** Creates the home and its git repository on first use. */
function ensureHome(home: string): void {
	mkdirSync(home, { recursive: true });
	if (!existsSync(join(home, '.git'))) git(home, ['init', '-q']);
}

/**
 * Writes records and commits them with `message`. Changes made by hand since
 * the last write are committed first, on their own, so the history says who
 * changed what.
 */
export function writeRecords(home: string, writes: { layer: Layer; record: Pick<MemoryRecord, 'id' | 'header' | 'body'> }[], message: string): string[] {
	ensureHome(home);
	if (git(home, ['status', '--porcelain']).trim()) {
		git(home, ['add', '-A']);
		git(home, ['commit', '-q', '-m', 'hand edits']);
	}
	const paths = writes.map(({ layer, record }) => {
		mkdirSync(layer.dir, { recursive: true });
		const path = recordPath(layer, record.id);
		writeFileSync(path, renderMemoryRecord(record));
		return path;
	});
	git(home, ['add', '--', ...paths.map((p) => relative(home, p))]);
	// A confirm on the day of the last one changes no byte, but its proof still goes into the history.
	git(home, ['commit', '-q', '--allow-empty', '-m', message]);
	return paths;
}

/**
 * The record's history, newest first: one `date message` line per commit
 * that changed its file, or that confirmed it (a confirm on an unchanged
 * file is an empty commit, which a path filter does not show).
 */
export function recordHistory(home: string, path: string, id: string): string[] {
	if (!existsSync(join(home, '.git'))) return [];
	const file = relative(home, path);
	const out = spawnSync('git', ['log', '--format=%x00%as %s', '--name-only'], { cwd: home, encoding: 'utf8' });
	if (out.status !== 0) return [];
	return out.stdout
		.split('\0')
		.filter(Boolean)
		.flatMap((entry) => {
			const [line = '', ...files] = entry.split('\n').filter(Boolean);
			const subject = line.slice(11);
			return files.includes(file) || subject.startsWith(`confirm ${id}:`) ? [line] : [];
		});
}
