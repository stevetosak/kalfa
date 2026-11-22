// The Cleanup at Task close (ADR 0003): the agent reconciles the closed Task
// Record into Long-term memory while its session still holds the work. kalfa
// gives the steps: the findings of the record's Remember parts, the commands
// that write them, the upkeep of a layer over its budget, and the command that
// marks the record reconciled.
import { memoryHome, scanLayer, sessionLayers } from '../../src/core/memory/home.ts';
import { budgetProblem } from '../../src/core/memory/standing.ts';
import type { Project } from '../../src/core/project.ts';
import { memoryBudgets, type Settings } from '../../src/core/settings.ts';
import { REMEMBER_PART, type TaskRecord } from '../../src/core/task-record.ts';
import { duplicateFindings, type Finding, findingLine } from './lint.ts';

const EMPTY = /^(none|n\/a|nothing|-)\.?$/i;
const BULLET = /^[-*+][ \t]+/;
/** Where a finding of the closing parts came from. */
export const CLOSE_LABEL = 'Task close';

/**
 * The findings in a Remember part: one per top-level bullet (its indented
 * lines belong to it), or the whole text when it has no bullets. "none" is no
 * finding.
 */
export function splitFindings(text: string): string[] {
	const lines = text.replace(/\r\n/g, '\n').split('\n');
	if (!lines.some((l) => BULLET.test(l))) return EMPTY.test(text.trim()) || !text.trim() ? [] : [text.trim()];
	const items: string[] = [];
	for (const line of lines) {
		if (BULLET.test(line)) items.push(line.replace(BULLET, ''));
		else if (items.length) items[items.length - 1] += `\n${line}`;
		else if (line.trim()) items.push(line);
	}
	return items.map((i) => i.trim()).filter((i) => i && !EMPTY.test(i));
}

/** One finding a Section marked in its Remember part. */
export interface RememberFinding {
	/** The Section's title, or CLOSE_LABEL for the closing parts. */
	from: string;
	text: string;
}

/** The findings of every Section's Remember part, then of the closing parts, in record order. */
export function rememberFindings(record: TaskRecord): RememberFinding[] {
	const sources = [...record.sections.map((s) => ({ from: s.title, parts: s.parts })), ...(record.close ? [{ from: CLOSE_LABEL, parts: record.close }] : [])];
	return sources.flatMap(({ from, parts }) => splitFindings(parts.get(REMEMBER_PART) ?? '').map((text) => ({ from, text })));
}

/** The upkeep of one layer over its budget, which the agent does in the Cleanup. */
export interface Upkeep {
	layer: string;
	/** How far over its budget the layer is. */
	problem: string;
	duplicates: Finding[];
	/** The layer's active open items, for the agent to close the finished ones. */
	open: { id: string; summary: string }[];
}

/** The upkeep of every layer a session here sees that is over its budget (ADR 0002, amendment 2026-11-08). */
export function upkeepHere(project: Project | undefined, coreSettings: Settings, env: NodeJS.ProcessEnv): Upkeep[] {
	const scans = sessionLayers(memoryHome(env), project).map((layer) => ({ layer, scan: scanLayer(layer) }));
	const duplicates = duplicateFindings({ scans });
	return scans.flatMap(({ layer, scan }) => {
		const problem = budgetProblem(layer, scan.records, memoryBudgets(coreSettings));
		if (!problem) return [];
		const open = scan.records.filter((r) => r.header.status === 'active' && r.header.type === 'open').map((r) => ({ id: r.id, summary: r.header.summary }));
		return [{ layer: layer.label, problem, duplicates: duplicates.filter((f) => f.layer === layer.label), open }];
	});
}

const oneLine = (text: string) => text.replace(/\s*\n\s*/g, ' ');

function findingSteps(task: string, key: string, findings: readonly RememberFinding[]): string[] {
	if (!findings.length) return ['Its Sections have no finding in a Remember part.'];
	return [
		'Findings in its Remember parts:',
		...findings.map((f) => `- ${f.from}: ${oneLine(f.text)}`),
		'For each finding:',
		'1. Check it against the later Sections, which may correct it; write what holds at the end.',
		'2. Search for its subject with `kalfa memory search "<words>"` and read each hit on it with `kalfa memory show <id>`.',
		`3. Write it, the body on stdin (or </dev/null): a record that says it and still holds → \`kalfa memory confirm <id> "<how this Task showed it>"\`; a record it changes → \`kalfa memory supersede <id> --summary "<one line>"\`; no record → \`kalfa memory add --type fact|decision|open --layer personal|project --summary "<one line>" --source "Task ${task} (${key})"\`; a rule → \`kalfa rule add --layer personal|project --summary "<the rule>"\`.`,
		'4. Link it: name the related records as [[id]] in its body ([[personal:id]] from a project record; a personal record never links into a project), and add a link to it in the Hub of its subject (supersede the Hub), or in the Root Hub when no Hub fits.',
	];
}

function upkeepSteps(upkeep: readonly Upkeep[]): string[] {
	if (!upkeep.length) return [];
	return [
		'Memory upkeep: a layer below is over its budget, so some of its records are Stored and do not load. Merge each likely duplicate (`kalfa memory supersede`) and close each open item whose work you can show is done (`kalfa memory close <id> "<how it was done>"`); keep an item open when you cannot show it.',
		...upkeep.flatMap((u) => [`- ${u.problem}`, ...u.duplicates.map((f) => `  ${findingLine(f)}`), ...u.open.map((o) => `  - open item ${u.layer}/${o.id}: ${o.summary}`)]),
	];
}

/** What the agent does at Task close: the steps of the Cleanup, then the command that marks the record. */
export function cleanupSteps(task: { id: string; key: string }, findings: readonly RememberFinding[], upkeep: readonly Upkeep[]): string {
	return [
		`Cleanup of Task ${task.id} (ADR 0003): take its findings into Long-term memory now, while this session still holds the work. You decide each one; do not ask the Operator.`,
		...findingSteps(task.id, task.key, findings),
		...upkeepSteps(upkeep),
		`Then mark the record: \`kalfa task reconciled --task ${task.id}\`.`,
	].join('\n');
}
