// The Memory home: one private folder outside every repository, with its own
// git history (ADR 0002). `personal/` is the Personal layer; each project's
// layer is `projects/<host>/<owner>/<repo>/`, keyed by its `origin` URL, so
// every work tree and clone of a repository shares it.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
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

export interface LayerScan {
	records: MemoryRecord[];
	/** One message per file that is not a valid record; such a file is left out. */
	problems: string[];
}

/** Every record of the layer; a file that is not a valid record is reported and left out. */
export function scanLayer(layer: Layer): LayerScan {
	const scan: LayerScan = { records: [], problems: [] };
	if (!existsSync(layer.dir)) return scan;
	for (const name of readdirSync(layer.dir).filter((n) => n.endsWith('.md')).sort()) {
		const path = join(layer.dir, name);
		try {
			scan.records.push(parseMemoryRecord(readFileSync(path, 'utf8'), path, name.slice(0, -3)));
		} catch (error) {
			if (!(error instanceof KalfaError)) throw error;
			scan.problems.push(error.message);
		}
	}
	return scan;
}

/** Every record of the layer; refused when a file is not a valid record (a write must see the whole layer). */
export function readLayer(layer: Layer): MemoryRecord[] {
	const { records, problems } = scanLayer(layer);
	if (problems.length) throw new KalfaError(`${problems.join('; ')} (fix the file by hand, then try again)`);
	return records;
}

/** The folder of a project's closed Task Records in the Memory home. */
export function projectTasksDir(home: string, project: Project): string {
	return join(projectLayer(home, project).dir, 'tasks');
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

export interface HomeChange {
	/** Files to write: absolute paths inside the home, with their text. */
	write?: { path: string; text: string }[];
	/** Files to remove: absolute paths inside the home. */
	remove?: string[];
}

/**
 * Writes and removes files in the Memory home and commits them as one change
 * with `message`. Changes made by hand since the last write are committed
 * first, on their own, so the history says who changed what.
 */
export function commitHome(home: string, change: HomeChange, message: string): void {
	ensureHome(home);
	const inside = (path: string) => {
		const rel = relative(home, path);
		if (!rel || rel.startsWith('..')) throw new KalfaError(`Memory home: ${path} is outside ${home}`);
		return rel;
	};
	if (git(home, ['status', '--porcelain']).trim()) {
		git(home, ['add', '-A']);
		git(home, ['commit', '-q', '-m', 'hand edits']);
	}
	const written = (change.write ?? []).map(({ path, text }) => {
		const rel = inside(path);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, text);
		return rel;
	});
	const removed = (change.remove ?? []).flatMap((path) => {
		const rel = inside(path);
		if (!existsSync(path)) return [];
		rmSync(path);
		return [rel];
	});
	const paths = [...written, ...removed];
	if (paths.length) git(home, ['add', '-A', '--', ...paths]);
	// A confirm on the day of the last one changes no byte, but its proof still goes into the history.
	git(home, ['commit', '-q', '--allow-empty', '-m', message]);
}

/** Writes records (and any other change) and commits them with `message`; returns the records' paths. */
export function writeRecords(home: string, writes: { layer: Layer; record: Pick<MemoryRecord, 'id' | 'header' | 'body'> }[], message: string, also: HomeChange = {}): string[] {
	const records = writes.map(({ layer, record }) => ({ path: recordPath(layer, record.id), text: renderMemoryRecord(record) }));
	commitHome(home, { write: [...records, ...(also.write ?? [])], remove: also.remove }, message);
	return records.map((r) => r.path);
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
