// A Memory record: one piece of memory in one Markdown file, a YAML header
// between `---` lines, then an optional body. Its layer is the folder it is
// in, so the header has no scope (ADR 0002).
import { stringify } from 'yaml';
import { z } from 'zod';
import { KalfaError } from '../errors.ts';
import { parseVersioned, type VersionedFormat } from '../versioned-file.ts';

/** A rule loads in full; the other types load as one index line. */
export const RECORD_TYPES = ['rule', 'fact', 'decision', 'open'] as const;
export type RecordType = (typeof RECORD_TYPES)[number];

/**
 * Only `active` records load. `proposed` ones wait for the Operator's review of
 * a sort; `superseded` ones name their successor; `closed` ones are done or no
 * longer apply (an open item that was finished), and search still finds them.
 */
export const RECORD_STATUSES = ['proposed', 'active', 'superseded', 'closed'] as const;
export type RecordStatus = (typeof RECORD_STATUSES)[number];

const ID = /^[a-z0-9][a-z0-9-]{0,79}$/;
export const recordId = z.string().regex(ID, 'an id is lower-case letters, digits and dashes (at most 80)');

const headerSchema = z
	.strictObject({
		schema: z.literal(1),
		type: z.enum(RECORD_TYPES),
		status: z.enum(RECORD_STATUSES),
		/** One line: the index line, and the first line of a rule. */
		summary: z
			.string()
			.trim()
			.min(1)
			.refine((s) => !s.includes('\n'), 'the summary is one line'),
		created: z.iso.date(),
		/** The last day someone checked that the record is still true. */
		confirmed: z.iso.date(),
		'superseded-by': recordId.optional(),
		/** Where the proof is, e.g. a Lesson's page. */
		source: z.string().min(1).optional(),
	})
	.refine((h) => (h.status === 'superseded') === (h['superseded-by'] !== undefined), {
		message: 'a superseded record names its successor in superseded-by, and only a superseded one does',
	});

export type RecordHeader = z.infer<typeof headerSchema>;

const headerFormat: VersionedFormat<RecordHeader> = { name: 'Memory record', current: 1, schema: headerSchema };

export interface MemoryRecord {
	id: string;
	header: RecordHeader;
	/** Markdown, trimmed; empty when the summary says it all. */
	body: string;
}

export function renderMemoryRecord(record: Pick<MemoryRecord, 'header' | 'body'>): string {
	const header = `---\n${stringify(record.header).trimEnd()}\n---\n`;
	return record.body ? `${header}\n${record.body}\n` : header;
}

export function parseMemoryRecord(text: string, path: string, id: string): MemoryRecord {
	const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text.replace(/\r\n/g, '\n'));
	if (!match) throw new KalfaError(`${path}: a Memory record starts with a --- YAML header ---`);
	return { id, header: parseVersioned(match[1]!, path, headerFormat), body: match[2]!.trim() };
}

/** Checks a header built in code (the CLI), with the same rules as a file. */
export function checkHeader(header: RecordHeader): RecordHeader {
	const result = headerSchema.safeParse(header);
	if (!result.success) throw new KalfaError(`the Memory record is not valid:\n${z.prettifyError(result.error)}`);
	return result.data;
}

/** An id from a summary: lower-case words joined by dashes, cut at a word end. */
export function slugOf(summary: string, max = 60): string {
	const words = summary
		.toLowerCase()
		.normalize('NFKD')
		.replace(/[̀-ͯ]/g, '')
		.split(/[^a-z0-9]+/)
		.filter(Boolean);
	let slug = '';
	for (const word of words) {
		const next = slug ? `${slug}-${word}` : word;
		if (next.length > max) break;
		slug = next;
	}
	return slug || words[0]?.slice(0, max) || 'record';
}

/** The text a rule loads with, and what its length limit counts. */
export function ruleText(record: MemoryRecord): string {
	return record.body ? `${record.header.summary}\n${record.body}` : record.header.summary;
}
