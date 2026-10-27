// The recorder: a first draft of the Task's Log, made from its Task Record.
// The record already holds what was done, found and decided per Section; the
// draft puts it in page order, and the agent edits it into the site's style
// and cuts what a later reader does not need.
import { basename, join } from 'node:path';
import type { Parts, TaskRecord } from '../../src/core/task-record.ts';

/** The parts the draft gathers at the end, not per Section. */
const GATHERED = new Set(['Next', 'Lesson candidates']);

function sectionBlock(title: string, parts: Parts): string[] {
	const lines = [`## ${title}`, ''];
	for (const [name, text] of parts) {
		if (GATHERED.has(name) || !text.trim()) continue;
		lines.push(name === 'Done' ? text.trim() : `**${name}:** ${text.trim()}`, '');
	}
	return lines;
}

const yamlString = (text: string) => JSON.stringify(text);

export function logDraft(record: TaskRecord, today: string): string {
	const { header, sections, close } = record;
	const lines = ['---', `title: ${yamlString(header.goal)}`, 'type: log', `date: ${header.closed ?? today}`, '---', ''];
	lines.push(`<!-- Draft from the kalfa Task Record ${basename(record.path)}: edit it into the Log style of this site, and cut what a later reader does not need. -->`, '');
	if (header.plan) lines.push(`Plan: ${header.plan}`, '');
	for (const section of sections) lines.push(...sectionBlock(section.title, section.parts));
	if (close) lines.push(...sectionBlock('Close', close));
	const candidates = sections.flatMap((s) => s.parts.get('Lesson candidates')?.trim() || []);
	if (candidates.length) lines.push('## Lesson candidates', '', ...candidates.flatMap((c) => [c, '']));
	const next = close?.get('Next') ?? sections.at(-1)?.parts.get('Next');
	if (next?.trim()) lines.push('## Next', '', next.trim(), '');
	return `${lines.join('\n').trimEnd()}\n`;
}

/** `Fix the push rule!` → `fix-the-push-rule`. */
export function slugOf(text: string): string {
	return (
		text
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-+|-+$/g, '')
			.slice(0, 60)
			.replace(/-+$/, '') || 'task'
	);
}

/** The Log's file in `dir`: `<date>-<slug of the goal>.md`. */
export const logFileIn = (dir: string, record: TaskRecord, today: string) => join(dir, `${record.header.closed ?? today}-${slugOf(record.header.goal)}.md`);
