// What the memory Module searches (ADR 0002): the Memory records of the
// layers a session sees, the Task Records (the repository's and the copies in
// the Memory home), the repository's tracked Markdown and the old archives.
// Each file becomes one or more chunks: a record is one chunk, a Task Record
// one per Section, a Markdown file one per heading (long ones split again).
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { globSync } from 'tinyglobby';
import { KalfaError } from '../../src/core/errors.ts';
import { memoryHome, projectTasksDir, sessionLayers } from '../../src/core/memory/home.ts';
import { parseMemoryRecord } from '../../src/core/memory/record.ts';
import type { Project } from '../../src/core/project.ts';
import { parseRecord, tasksDir } from '../../src/core/task-record.ts';

export const SOURCE_KINDS = ['memory', 'task', 'doc', 'archive'] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

export interface SourceFile {
	path: string;
	kind: SourceKind;
	/** For display: the path from the repository root, or the record's layer. */
	label: string;
	/** The path a reference names: from the repository root inside it, else absolute. */
	refPath: string;
	mtimeMs: number;
	size: number;
}

export interface Chunk {
	/** Unique in one index: the file and the chunk's number in it. */
	id: string;
	kind: SourceKind;
	title: string;
	text: string;
	/** Where to read it in full: `path:line`, or the kalfa command that shows it. */
	ref: string;
	/** For a Task Record chunk: the Task's id. */
	task?: string;
}

/** A Markdown file larger than this is not indexed (a generated page, a dump). */
const MAX_FILE_BYTES = 512 * 1024;
/** A chunk longer than this is split at a blank line. */
export const MAX_CHUNK_CHARS = 2000;

export interface SourceScope {
	project: Project | undefined;
	env: NodeJS.ProcessEnv;
	/** Archive globs from the repository root. */
	archives: readonly string[];
}

function statOf(path: string): { mtimeMs: number; size: number } | undefined {
	const stat = statSync(path, { throwIfNoEntry: false });
	return stat?.isFile() ? { mtimeMs: stat.mtimeMs, size: stat.size } : undefined;
}

const markdownIn = (dir: string) => (existsSync(dir) ? readdirSync(dir).filter((n) => n.endsWith('.md')).sort() : []);

function trackedMarkdown(root: string): string[] {
	const out = spawnSync('git', ['ls-files', '-z', '--', '*.md'], { cwd: root, encoding: 'utf8' });
	if (out.status !== 0) throw new KalfaError(`git ls-files failed in ${root}: ${(out.stderr || out.error?.message || '').trim()}`);
	return out.stdout.split('\0').filter(Boolean);
}

/** Every file the index is made from, in a stable order; its stats are the index's fingerprint. */
export function listSources(scope: SourceScope): SourceFile[] {
	const files: SourceFile[] = [];
	const seen = new Set<string>();
	const root = scope.project?.root;
	const add = (path: string, kind: SourceKind, label: string) => {
		if (seen.has(path)) return;
		const stat = statOf(path);
		if (!stat || stat.size > MAX_FILE_BYTES) return;
		seen.add(path);
		const inRepo = root !== undefined && !relative(root, path).startsWith('..');
		files.push({ path, kind, label, refPath: inRepo ? relative(root, path) : path, ...stat });
	};
	const home = memoryHome(scope.env);
	for (const layer of sessionLayers(home, scope.project)) for (const name of markdownIn(layer.dir)) add(join(layer.dir, name), 'memory', layer.label);

	const project = scope.project;
	if (!project) return files;
	// The repository's record is the newer one while the Task is open; a copy
	// counts when its work tree is gone.
	const repoTasks = markdownIn(tasksDir(project.root));
	for (const name of repoTasks) add(join(tasksDir(project.root), name), 'task', relative(project.root, join(tasksDir(project.root), name)));
	const copies = projectTasksDir(home, project);
	for (const name of markdownIn(copies)) if (!repoTasks.includes(name)) add(join(copies, name), 'task', `memory home: tasks/${name}`);
	for (const path of trackedMarkdown(project.root)) add(join(project.root, path), 'doc', path);
	const archives = scope.archives.length ? globSync([...scope.archives], { cwd: project.root, dot: true, absolute: true, onlyFiles: true }) : [];
	for (const path of archives.sort()) add(path, 'archive', relative(project.root, path));
	return files;
}

interface MarkdownPiece {
	headings: string[];
	line: number;
	text: string;
}

const HEADING = /^(#{1,6})[ \t]+(.+?)[ \t#]*$/;
const FENCE = /^[ \t]*(```|~~~)/;

/** Splits lines into pieces of at most `max` characters, at a blank line where it can. */
function splitLong(lines: string[], firstLine: number, max: number): { line: number; text: string }[] {
	const pieces: { line: number; text: string }[] = [];
	let start = 0;
	while (start < lines.length) {
		let end = start;
		let size = 0;
		let lastBlank = -1;
		while (end < lines.length && (end === start || size + lines[end]!.length + 1 <= max)) {
			size += lines[end]!.length + 1;
			if (!lines[end]!.trim() && end > start) lastBlank = end;
			end++;
		}
		if (end < lines.length && lastBlank > start) end = lastBlank;
		const text = lines.slice(start, end).join('\n').trim();
		if (text) pieces.push({ line: firstLine + start, text });
		start = end;
	}
	return pieces;
}

/** A Markdown text as pieces under their heading path; a heading inside a code fence is text. */
export function markdownPieces(text: string, max = MAX_CHUNK_CHARS): MarkdownPiece[] {
	const lines = text.replace(/\r\n/g, '\n').split('\n');
	const pieces: MarkdownPiece[] = [];
	let headings: string[] = [];
	// By level, so a file without a level-1 heading still nests right.
	const levels: (string | undefined)[] = [];
	let body: string[] = [];
	let bodyLine = 1;
	let fence: string | undefined;
	const flush = () => {
		for (const piece of splitLong(body, bodyLine, max)) pieces.push({ headings, ...piece });
	};
	lines.forEach((line, index) => {
		const fenceMark = FENCE.exec(line)?.[1];
		if (fenceMark && (!fence || fence === fenceMark)) fence = fence ? undefined : fenceMark;
		const heading = fence || fenceMark ? undefined : HEADING.exec(line);
		if (!heading) {
			body.push(line);
			return;
		}
		flush();
		const level = heading[1]!.length;
		levels.length = level - 1;
		levels[level - 1] = heading[2]!;
		headings = levels.filter((h): h is string => h !== undefined);
		// A heading alone still finds its section; its body follows.
		body = [line];
		bodyLine = index + 1;
	});
	flush();
	return pieces;
}

function memoryChunks(file: SourceFile, text: string): Chunk[] {
	const id = basename(file.path, '.md');
	const record = parseMemoryRecord(text, file.path, id);
	if (record.header.status === 'superseded') return [];
	const { status } = record.header;
	const mark = status === 'proposed' || status === 'closed' ? ` (${status})` : '';
	return [
		{
			id: `${file.path}#0`,
			kind: 'memory',
			title: `${record.header.type}${mark}: ${record.header.summary}`,
			text: record.body,
			ref: `kalfa memory show ${id} (${file.label})`,
		},
	];
}

function taskChunks(file: SourceFile, text: string): Chunk[] {
	const id = basename(file.path, '.md');
	const record = parseRecord(text, file.path, id);
	const parts = (map: Map<string, string>) => [...map].map(([name, body]) => `${name}: ${body}`).join('\n');
	const blocks = [...record.sections.map((s) => ({ title: s.title, parts: s.parts })), ...(record.close ? [{ title: 'Close', parts: record.close }] : [])];
	const lines = text.split('\n');
	return blocks.map((block, n) => {
		const heading = block.title === 'Close' ? '## Close' : `## Section: ${block.title}`;
		const line = lines.findIndex((l) => l.trim() === heading) + 1 || 1;
		return {
			id: `${file.path}#${n}`,
			kind: 'task' as const,
			title: `Task ${id} (${record.header.goal}): ${block.title}`,
			text: parts(block.parts),
			ref: `${file.refPath}:${line}`,
			task: id,
		};
	});
}

function markdownChunks(file: SourceFile, text: string): Chunk[] {
	return markdownPieces(text).map((piece, n) => ({
		id: `${file.path}#${n}`,
		kind: file.kind,
		title: [file.label, ...piece.headings].join(' › '),
		text: piece.text,
		ref: `${file.refPath}:${piece.line}`,
	}));
}

/** The chunks of one file; a file kalfa cannot read as its kind gives none and is named in `problems`. */
export function chunksOf(file: SourceFile, problems: string[]): Chunk[] {
	try {
		const text = readFileSync(file.path, 'utf8');
		if (file.kind === 'memory') return memoryChunks(file, text);
		if (file.kind === 'task') return taskChunks(file, text);
		return markdownChunks(file, text);
	} catch (error) {
		if (!(error instanceof KalfaError) && (error as NodeJS.ErrnoException).code === undefined) throw error;
		problems.push((error as Error).message);
		return [];
	}
}
