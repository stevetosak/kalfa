// The Task Record: one Task's Sections with what was done, found with proof,
// decided, the Lesson candidates and the next step. It lives in
// `<repo>/.kalfa/tasks/<task>.md`: a YAML header, then one `## Section:`
// block per closed Section, each made of `**Part:** text` parts.
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { z } from 'zod';
import { KalfaError } from './errors.ts';
import { PRIVATE_DIR, privateDir } from './private-dir.ts';
import { parseVersioned, type VersionedFormat } from './versioned-file.ts';

/** The Core's parts, in the order a Section prints them. Module parts are `<module>.<part>`. */
export const CORE_PARTS = ['Done', 'Found', 'Decisions', 'Lesson candidates', 'Next'] as const;
const REQUIRED_PART = 'Done';
const PART_LINE = /^\*\*([^*:]+):\*\*[ \t]*(.*)$/;
const MODULE_PART = /^([a-z][a-z0-9-]*)\.([a-z][a-z0-9-]*)$/;
const SECTION_HEADING = '## Section: ';
const CLOSE_HEADING = '## Close';

const headerSchema = z.strictObject({
	schema: z.literal(1),
	goal: z.string().min(1),
	branch: z.string().optional(),
	plan: z.string().optional(),
	status: z.enum(['open', 'closed']),
	started: z.iso.date(),
	closed: z.iso.date().optional(),
});

export type TaskHeader = z.infer<typeof headerSchema>;

const headerFormat: VersionedFormat<TaskHeader> = { name: 'Task Record', current: 1, schema: headerSchema };

/** Parts by name, in the order they were written. */
export type Parts = Map<string, string>;

export interface Section {
	title: string;
	parts: Parts;
}

export interface TaskRecord {
	id: string;
	path: string;
	header: TaskHeader;
	sections: Section[];
	/** The parts given when the Task closed. */
	close?: Parts;
}

/** A Task id from a branch name: `feat/monitoring` → `feat-monitoring`. */
export function taskIdOf(branch: string): string {
	return branch.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|-+$/g, '');
}

/**
 * Splits Markdown into parts and checks their names: Core parts, or parts of
 * the enabled Modules. Text before the first part is refused.
 */
export function parseParts(text: string, isEnabled: (module: string) => boolean, where: string): Parts {
	const parts: Parts = new Map();
	let current: string | undefined;
	const lines: Record<string, string[]> = {};
	for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
		const match = PART_LINE.exec(line);
		if (match) {
			const name = match[1]!.trim();
			checkPartName(name, isEnabled, where);
			if (parts.has(name)) throw new KalfaError(`${where}: the part **${name}:** is given twice`);
			parts.set(name, '');
			lines[name] = [match[2]!];
			current = name;
		} else if (current) {
			lines[current]!.push(line);
		} else if (line.trim()) {
			throw new KalfaError(`${where}: text before the first part; start each part with **<Part>:** (${CORE_PARTS.join(', ')})`);
		}
	}
	for (const name of parts.keys()) {
		const body = lines[name]!.join('\n').trim();
		if (!body) throw new KalfaError(`${where}: the part **${name}:** is empty`);
		parts.set(name, body);
	}
	return parts;
}

function checkPartName(name: string, isEnabled: (module: string) => boolean, where: string): void {
	if ((CORE_PARTS as readonly string[]).includes(name)) return;
	const module = MODULE_PART.exec(name)?.[1];
	if (module && isEnabled(module)) return;
	const hint = module ? `the Module ${module} is not enabled in kalfa.yaml` : `use ${CORE_PARTS.join(', ')}, or <module>.<part> for an enabled Module`;
	throw new KalfaError(`${where}: unknown part **${name}:**; ${hint}`);
}

export function sectionParts(text: string, modules: readonly string[]): Parts {
	const parts = parseParts(text, (module) => modules.includes(module), 'the Section');
	if (!parts.has(REQUIRED_PART)) throw new KalfaError(`the Section needs a **${REQUIRED_PART}:** part`);
	return parts;
}

function renderParts(parts: Parts): string {
	return [...parts].map(([name, body]) => `**${name}:** ${body}`).join('\n\n');
}

export function renderRecord(record: Omit<TaskRecord, 'id' | 'path'>): string {
	const blocks = [`---\n${stringify(record.header).trimEnd()}\n---`];
	for (const section of record.sections) blocks.push(`${SECTION_HEADING}${section.title}\n\n${renderParts(section.parts)}`);
	if (record.close) blocks.push(`${CLOSE_HEADING}\n\n${renderParts(record.close)}`);
	return `${blocks.join('\n\n')}\n`;
}

export function parseRecord(text: string, path: string, id: string): TaskRecord {
	const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text.replace(/\r\n/g, '\n'));
	if (!match) throw new KalfaError(`${path}: a Task Record starts with a --- YAML header ---`);
	const header = parseVersioned(match[1]!, path, headerFormat);
	const record: TaskRecord = { id, path, header, sections: [] };
	// Parts were checked when written; reading accepts any Module part, so a
	// Module turned off later does not make old records unreadable.
	const anyModule = () => true;
	const blocks = match[2]!.split(/^(?=## )/m).filter((block) => block.trim());
	for (const block of blocks) {
		const [heading = '', ...rest] = block.split('\n');
		const body = rest.join('\n');
		if (heading.startsWith(SECTION_HEADING)) {
			record.sections.push({ title: heading.slice(SECTION_HEADING.length).trim(), parts: parseParts(body, anyModule, path) });
		} else if (heading.trim() === CLOSE_HEADING) {
			record.close = parseParts(body, anyModule, path);
		} else {
			throw new KalfaError(`${path}: unexpected heading '${heading.trim()}'`);
		}
	}
	return record;
}

export function tasksDir(root: string): string {
	return join(root, PRIVATE_DIR, 'tasks');
}

export function recordPath(root: string, id: string): string {
	return join(tasksDir(root), `${id}.md`);
}

export function readRecord(root: string, id: string): TaskRecord | undefined {
	const path = recordPath(root, id);
	if (!existsSync(path)) return undefined;
	return parseRecord(readFileSync(path, 'utf8'), path, id);
}

/** Writes the record; refused unless git ignores `.kalfa/`. */
export function writeRecord(root: string, record: Omit<TaskRecord, 'path'>): string {
	privateDir(root);
	mkdirSync(tasksDir(root), { recursive: true });
	const path = recordPath(root, record.id);
	writeFileSync(path, renderRecord(record));
	return path;
}

export function listRecords(root: string): TaskRecord[] {
	const dir = tasksDir(root);
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((name) => name.endsWith('.md'))
		.sort()
		.map((name) => parseRecord(readFileSync(join(dir, name), 'utf8'), join(dir, name), name.slice(0, -3)));
}

/** The short view a fresh session reads to go on with the Task. */
export function handoffView(record: TaskRecord): string {
	const { header, sections } = record;
	const last = sections.at(-1);
	const lines = [`Task ${record.id}: ${header.goal} (${header.status}${header.plan ? `; Plan ${header.plan}` : ''})`, `Record: ${record.path}`];
	if (sections.length) lines.push(`Sections closed: ${sections.map((s) => s.title).join('; ')}`);
	if (last?.parts.get('Found')) lines.push('', `Found in "${last.title}":`, last.parts.get('Found')!);
	const candidates = sections.flatMap((s) => (s.parts.get('Lesson candidates') ? [s.parts.get('Lesson candidates')!] : []));
	if (candidates.length) lines.push('', 'Lesson candidates:', ...candidates);
	const next = record.close?.get('Next') ?? last?.parts.get('Next');
	lines.push('', `Next: ${next ?? 'not recorded'}`);
	return lines.join('\n');
}
