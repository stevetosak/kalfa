// The inbox: Memory candidates that wait for the Operator's answer (ADR 0002).
// One file per candidate in `inbox/` of the Memory home, outside every layer,
// so a candidate never loads before the Operator accepts it.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { z } from 'zod';
import { KalfaError } from '../../src/core/errors.ts';
import { parseVersioned, type VersionedFormat } from '../../src/core/versioned-file.ts';

const headerSchema = z.strictObject({
	schema: z.literal(1),
	/** The project key of the Task that found it. */
	project: z.string().min(1),
	task: z.string().min(1),
	created: z.iso.date(),
});

type CandidateHeader = z.infer<typeof headerSchema>;

const headerFormat: VersionedFormat<CandidateHeader> = { name: 'Memory candidate', current: 1, schema: headerSchema };

export interface Candidate extends CandidateHeader {
	id: string;
	path: string;
	text: string;
}

export function inboxDir(home: string): string {
	return join(home, 'inbox');
}

export function readInbox(home: string): { candidates: Candidate[]; problems: string[] } {
	const dir = inboxDir(home);
	const out = { candidates: [] as Candidate[], problems: [] as string[] };
	if (!existsSync(dir)) return out;
	for (const name of readdirSync(dir).filter((n) => n.endsWith('.md')).sort()) {
		const path = join(dir, name);
		const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(readFileSync(path, 'utf8').replace(/\r\n/g, '\n'));
		try {
			if (!match) throw new KalfaError(`${path}: a Memory candidate starts with a --- YAML header ---`);
			out.candidates.push({ id: name.slice(0, -3), path, ...parseVersioned(match[1]!, path, headerFormat), text: match[2]!.trim() });
		} catch (error) {
			if (!(error instanceof KalfaError)) throw error;
			out.problems.push(error.message);
		}
	}
	return out;
}

export function findCandidate(home: string, id: string): Candidate {
	const candidate = readInbox(home).candidates.find((c) => c.id === id);
	if (!candidate) throw new KalfaError(`no Memory candidate '${id}' in the inbox (kalfa memory inbox)`);
	return candidate;
}

const EMPTY = /^(none|n\/a|nothing|-)\.?$/i;

/**
 * The candidates in a Memory candidates part: one per top-level bullet (its
 * indented lines belong to it), or the whole text when it has no bullets.
 * "none" is no candidate.
 */
export function splitCandidates(text: string): string[] {
	const lines = text.replace(/\r\n/g, '\n').split('\n');
	const bullet = /^[-*+][ \t]+/;
	if (!lines.some((l) => bullet.test(l))) return EMPTY.test(text.trim()) || !text.trim() ? [] : [text.trim()];
	const items: string[] = [];
	for (const line of lines) {
		if (bullet.test(line)) items.push(line.replace(bullet, ''));
		else if (items.length) items[items.length - 1] += `\n${line}`;
		else if (line.trim()) items.push(line);
	}
	return items.map((i) => i.trim()).filter((i) => i && !EMPTY.test(i));
}

const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

/**
 * The inbox files for a closed Task's candidates. A candidate already in the
 * inbox for the same Task (a Task closed twice) is not written again.
 */
export function candidateFiles(home: string, header: Omit<CandidateHeader, 'schema'>, texts: readonly string[]): { id: string; path: string; text: string; candidate: string }[] {
	const existing = readInbox(home).candidates;
	const taken = new Set(existing.map((c) => c.id));
	const base = `${slug(header.project.split('/').at(-1) ?? 'project')}-${slug(header.task)}`.slice(0, 70);
	const files: { id: string; path: string; text: string; candidate: string }[] = [];
	let n = 0;
	for (const candidate of texts) {
		if (existing.some((c) => c.project === header.project && c.task === header.task && c.text === candidate)) continue;
		let id: string;
		do id = `${base}-${++n}`;
		while (taken.has(id));
		taken.add(id);
		const text = `---\n${stringify({ schema: 1, ...header }).trimEnd()}\n---\n\n${candidate}\n`;
		files.push({ id, path: join(inboxDir(home), `${id}.md`), text, candidate });
	}
	return files;
}
