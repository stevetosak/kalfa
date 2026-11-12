// A deferred item (ADR 0002, amendment 2026-11-08): work the Operator has not
// taken on. It is not memory, so it is not a Memory record: one Markdown file
// in the `deferred/` folder of its layer in the Memory home, private as the
// layer is. A YAML header between `---` lines, then the body: why it waits and
// where it came from. An item is never deleted: taken or dropped, it leaves the
// list, and its file and history stay.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { stringify } from 'yaml';
import { z } from 'zod';
import { KalfaError } from '../../src/core/errors.ts';
import { commitHome, deferredDir, type Layer } from '../../src/core/memory/home.ts';
import { recordId } from '../../src/core/memory/record.ts';
import { parseVersioned, type VersionedFormat } from '../../src/core/versioned-file.ts';

/** `open` is on the list; `taken` the Operator took on (a Plan or a Task); `dropped` will not be done. */
export const DEFERRED_STATUSES = ['open', 'taken', 'dropped'] as const;
export type DeferredStatus = (typeof DEFERRED_STATUSES)[number];

const oneLine = (what: string) =>
	z
		.string()
		.trim()
		.min(1)
		.refine((s) => !s.includes('\n'), `the ${what} is one line`);

const headerSchema = z.strictObject({
	schema: z.literal(1),
	status: z.enum(DEFERRED_STATUSES),
	summary: oneLine('summary'),
	created: z.iso.date(),
	/** What brings it back. Only a condition to report: it never starts the work. */
	condition: oneLine('condition').optional(),
	/** The day it was taken on or dropped. */
	closed: z.iso.date().optional(),
});

export type DeferredHeader = z.infer<typeof headerSchema>;

const headerFormat: VersionedFormat<DeferredHeader> = { name: 'deferred item', current: 1, schema: headerSchema };

export interface DeferredItem {
	id: string;
	header: DeferredHeader;
	/** Markdown, trimmed: why it waits, and its source. */
	body: string;
}

export const itemPath = (layer: Layer, id: string): string => join(deferredDir(layer), `${id}.md`);

export function renderItem(item: Pick<DeferredItem, 'header' | 'body'>): string {
	const header = `---\n${stringify(item.header).trimEnd()}\n---\n`;
	return item.body ? `${header}\n${item.body}\n` : header;
}

export function parseItem(text: string, path: string, id: string): DeferredItem {
	const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text.replace(/\r\n/g, '\n'));
	if (!match) throw new KalfaError(`${path}: a deferred item starts with a --- YAML header ---`);
	return { id, header: parseVersioned(match[1]!, path, headerFormat), body: match[2]!.trim() };
}

/** Checks a header built in code, with the same rules as a file. */
export function checkItemHeader(header: DeferredHeader): DeferredHeader {
	const result = headerSchema.safeParse(header);
	if (!result.success) throw new KalfaError(`the deferred item is not valid:\n${z.prettifyError(result.error)}`);
	return result.data;
}

export const checkItemId = (id: string): string => {
	const result = recordId.safeParse(id);
	if (!result.success) throw new KalfaError(`'${id}': ${result.error.issues[0]?.message}`);
	return id;
};

export interface DeferredScan {
	items: DeferredItem[];
	/** One message per file that is not a valid item; such a file is left out. */
	problems: string[];
}

/** Every item of the layer, oldest first; a file that is not a valid item is reported and left out. */
export function scanDeferred(layer: Layer): DeferredScan {
	const scan: DeferredScan = { items: [], problems: [] };
	const dir = deferredDir(layer);
	if (!existsSync(dir)) return scan;
	for (const name of readdirSync(dir).filter((n) => n.endsWith('.md')).sort()) {
		const path = join(dir, name);
		try {
			scan.items.push(parseItem(readFileSync(path, 'utf8'), path, basename(name, '.md')));
		} catch (error) {
			scan.problems.push((error as Error).message);
		}
	}
	scan.items.sort((a, b) => a.header.created.localeCompare(b.header.created) || a.id.localeCompare(b.id));
	return scan;
}

/** Writes one item and commits it in the Memory home with `message`. */
export function writeItem(home: string, layer: Layer, item: DeferredItem, message: string): string {
	const path = itemPath(layer, item.id);
	commitHome(home, { write: [{ path, text: renderItem({ header: checkItemHeader(item.header), body: item.body }) }] }, message);
	return path;
}

/** The list line of an open item; its condition on a second line. */
export const itemLine = (item: DeferredItem, layer?: Layer): string =>
	`- ${item.id} (${item.header.created}${layer ? `, ${layer.label}` : ''}): ${item.header.summary}${item.header.condition ? `\n  when: ${item.header.condition}` : ''}`;
