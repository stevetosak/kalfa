// Keyword search over everything curated (ADR 0002): a MiniSearch index of
// the sources' chunks. The index is a cache in the machine's cache folder, one
// per repository (or one for the Personal layer alone outside a repository),
// built again when the list of source files or one file's size or time
// changes. This file is the one place that knows MiniSearch, so a library
// with vectors can replace it later.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import MiniSearch, { type Options } from 'minisearch';
import { machineCacheDir } from '../../src/core/machine-paths.ts';
import { memoryHome } from '../../src/core/memory/home.ts';
import { type Chunk, chunksOf, listSources, type SourceFile, type SourceKind, type SourceScope } from './sources.ts';
import { keepTerm } from './words.ts';

/** Changes when the chunks or the options change, so an old cache is not read. */
const INDEX_VERSION = 1;
const SNIPPET_CHARS = 240;

type Stored = Pick<Chunk, 'kind' | 'title' | 'ref' | 'task'> & { snippet: string };

export interface Hit extends Stored {
	score: number;
}

const OPTIONS: Options<Chunk & { snippet: string }> = {
	fields: ['title', 'text'],
	storeFields: ['kind', 'title', 'ref', 'task', 'snippet'],
	processTerm: keepTerm,
	searchOptions: {
		boost: { title: 2 },
		combineWith: 'OR',
		prefix: (term) => term.length >= 4,
		fuzzy: (term) => (term.length >= 5 ? 0.2 : false),
	},
};

export interface SearchIndex {
	search(query: string, limit: number, keep?: (hit: Hit) => boolean): Hit[];
	/** Source files that could not be read as their kind; they are left out. */
	problems: string[];
	/** The index was read from the cache, not built. */
	cached: boolean;
}

function fingerprint(files: readonly SourceFile[]): string {
	const list = files.map((f) => [f.path, f.kind, f.mtimeMs, f.size]);
	return createHash('sha256').update(JSON.stringify({ version: INDEX_VERSION, list })).digest('hex');
}

/** The cache file of a scope: one per repository, and one for outside every repository. */
function cachePath(scope: SourceScope): string {
	const owner = `${memoryHome(scope.env)}\0${scope.project?.root ?? ''}`;
	return join(machineCacheDir(scope.env), 'memory-search', `${createHash('sha256').update(owner).digest('hex').slice(0, 16)}.json`);
}

interface CacheFile {
	fingerprint: string;
	problems: string[];
	index: unknown;
}

function readCache(path: string, print: string): { mini: MiniSearch<Chunk & { snippet: string }>; problems: string[] } | undefined {
	try {
		const cache = JSON.parse(readFileSync(path, 'utf8')) as CacheFile;
		if (cache.fingerprint !== print) return undefined;
		return { mini: MiniSearch.loadJS(cache.index as Parameters<typeof MiniSearch.loadJS>[0], OPTIONS), problems: cache.problems };
	} catch {
		// No cache, or one from another version: build again.
		return undefined;
	}
}

function writeCache(path: string, cache: CacheFile): void {
	try {
		mkdirSync(join(path, '..'), { recursive: true });
		const temp = `${path}.${process.pid}.tmp`;
		writeFileSync(temp, JSON.stringify(cache));
		renameSync(temp, path);
	} catch {
		// The cache only saves time; search works without it.
	}
}

function build(files: readonly SourceFile[]): { mini: MiniSearch<Chunk & { snippet: string }>; problems: string[] } {
	const problems: string[] = [];
	const mini = new MiniSearch(OPTIONS);
	for (const file of files) {
		const chunks = chunksOf(file, problems).map((chunk) => ({ ...chunk, snippet: chunk.text.replace(/\s+/g, ' ').trim().slice(0, SNIPPET_CHARS) }));
		mini.addAll(chunks);
	}
	return { mini, problems };
}

/** The scope's index: from the cache when no source changed, else built and cached. */
export function openIndex(scope: SourceScope): SearchIndex {
	const files = listSources(scope);
	const print = fingerprint(files);
	const path = cachePath(scope);
	const cached = readCache(path, print);
	const { mini, problems } = cached ?? build(files);
	if (!cached) writeCache(path, { fingerprint: print, problems, index: mini });
	return {
		problems,
		cached: cached !== undefined,
		search(query, limit, keep = () => true) {
			if (!query.trim()) return [];
			const hits: Hit[] = [];
			for (const result of mini.search(query)) {
				const hit: Hit = {
					kind: result.kind as SourceKind,
					title: result.title as string,
					ref: result.ref as string,
					snippet: result.snippet as string,
					score: result.score,
					...(result.task ? { task: result.task as string } : {}),
				};
				if (!keep(hit)) continue;
				hits.push(hit);
				if (hits.length >= limit) break;
			}
			return hits;
		},
	};
}

/** One line per hit, the way recall injects it. */
export const hitLine = (hit: Hit): string => `- [${hit.kind}] ${hit.title} — ${hit.ref}`;
