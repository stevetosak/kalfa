// Plans: tracked lists of steps in Markdown pages, found through the project
// file's `plans:` globs. The format is the documentation site Contract's, so
// a page reads the same here and on the site:
//
// - YAML frontmatter with `type: plan`, a `title` and a `status`; a matched
//   page of another type is skipped.
// - A step is a top-level GFM task item: `- [x]` done, `- [ ]` open, and a
//   step whose text starts with ~~struck~~ text is dropped. A `##` heading
//   above a step names its group. Task items nested in a step are its
//   sub-items. Plain list items are prose, not steps.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { List, ListItem, Paragraph, PhrasingContent, RootContent } from 'mdast';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { toString } from 'mdast-util-to-string';
import { gfm } from 'micromark-extension-gfm';
import { globSync } from 'tinyglobby';
import { parse } from 'yaml';
import { z } from 'zod';
import { KalfaError } from './errors.ts';
import { PRIVATE_DIR } from './private-dir.ts';

export const PLAN_STATUSES = ['proposed', 'active', 'done', 'abandoned'] as const;
export type PlanStatus = (typeof PLAN_STATUSES)[number];

export type StepState = 'done' | 'open' | 'dropped';

export interface PlanStep {
	state: StepState;
	/** The step's first paragraph as plain text. */
	text: string;
	/** The bold words a step opens with, else the text. */
	label: string;
	/** The `##` heading the step sits under, if any. */
	group?: string;
	/** Line in the file (1-based). */
	line: number;
	subItems: PlanStep[];
}

export interface PlanSteps {
	steps: PlanStep[];
	/** List items that look like a step but carry a mark the format does not know. */
	unknownMarks: { mark: string; line: number }[];
}

export interface Plan extends PlanSteps {
	/** Relative to the repository root. */
	path: string;
	title: string;
	status: PlanStatus;
}

export interface Progress {
	done: number;
	open: number;
	dropped: number;
	/** Steps that count: done + open. A dropped step is not work left or work done. */
	total: number;
}

// `[~]`, `[-]`, `[/]` …: one character between brackets that GFM does not read as a task.
const UNKNOWN_MARK = /^\[([^\sxX\]])\]\s/;

const firstParagraph = (item: ListItem) => item.children.find((c): c is Paragraph => c.type === 'paragraph');

function stateOf(item: ListItem, paragraph: Paragraph | undefined): StepState {
	if (paragraph?.children[0]?.type === 'delete') return 'dropped';
	return item.checked ? 'done' : 'open';
}

function labelOf(paragraph: Paragraph | undefined, text: string): string {
	const lead: PhrasingContent | undefined = paragraph?.children[0];
	return lead?.type === 'strong' ? toString(lead).trim() : text;
}

function readItem(item: ListItem, group: string | undefined, lineOffset: number, out: PlanSteps): PlanStep | undefined {
	const paragraph = firstParagraph(item);
	const line = (item.position?.start.line ?? 0) + lineOffset;
	if (typeof item.checked !== 'boolean') {
		const mark = UNKNOWN_MARK.exec(paragraph ? toString(paragraph) : '');
		if (mark) out.unknownMarks.push({ mark: `[${mark[1]}]`, line });
		return undefined;
	}
	const text = paragraph ? toString(paragraph).replace(/\s+/g, ' ').trim() : '';
	const subItems = item.children
		.filter((c): c is List => c.type === 'list')
		.flatMap((list) => list.children.flatMap((sub) => readItem(sub, group, lineOffset, out) ?? []));
	return { state: stateOf(item, paragraph), text, label: labelOf(paragraph, text), group, line, subItems };
}

/**
 * Reads the steps of a Plan body. `lineOffset` is the number of lines before
 * the body in the file (the frontmatter), so reported lines match the file.
 */
export function readPlanSteps(body: string, lineOffset = 0): PlanSteps {
	const tree = fromMarkdown(body, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });
	const out: PlanSteps = { steps: [], unknownMarks: [] };
	let group: string | undefined;
	for (const node of tree.children as RootContent[]) {
		if (node.type === 'heading' && node.depth === 2) group = toString(node).trim();
		if (node.type === 'list') out.steps.push(...node.children.flatMap((item) => readItem(item, group, lineOffset, out) ?? []));
	}
	return out;
}

export function progressOf(steps: PlanStep[]): Progress {
	const count = (state: StepState) => steps.filter((s) => s.state === state).length;
	const [done, open, dropped] = [count('done'), count('open'), count('dropped')];
	return { done, open, dropped, total: done + open };
}

/** Every open step or sub-item at any depth, a step before its sub-items. */
export const openAnywhere = (steps: PlanStep[]): PlanStep[] =>
	steps.flatMap((s) => [...(s.state === 'open' ? [s] : []), ...openAnywhere(s.subItems)]);

export const isOpenPlan = (plan: Plan) => plan.status === 'proposed' || plan.status === 'active';

/** The format's rules for a Plan's steps; one message per problem. */
export function planStepProblems(plan: Plan): string[] {
	const problems = plan.unknownMarks.map(
		({ mark, line }) => `line ${line}: "${mark}" is not a step mark; use "- [ ]" or "- [x]", and strike a dropped step's text with ~~ ~~.`,
	);
	if (isOpenPlan(plan) && plan.steps.length === 0) problems.push('an open Plan needs at least one step (a "- [ ]" task item).');
	if (plan.status === 'done') {
		const open = openAnywhere(plan.steps);
		if (open.length) problems.push(`a done Plan has ${open.length} open step(s), first at line ${open[0]!.line}; tick or strike them, or set another status.`);
	}
	return problems;
}

const FRONTMATTER = /^---\n([\s\S]*?)\n---(?:\n|$)/;

// Only what kalfa reads; a page may carry more keys for its site.
const planHeader = z.looseObject({
	type: z.literal('plan'),
	title: z.string().min(1),
	status: z.enum(PLAN_STATUSES),
});

/** The Plan in `text`, or `undefined` when the page is not a Plan. */
export function parsePlan(text: string, path: string): Plan | undefined {
	const normal = text.replace(/\r\n/g, '\n');
	const match = FRONTMATTER.exec(normal);
	if (!match) return undefined;
	let data: unknown;
	try {
		data = parse(match[1]!);
	} catch (error) {
		throw new KalfaError(`${path}: the frontmatter is not valid YAML: ${(error as Error).message}`);
	}
	if (typeof data !== 'object' || data === null || (data as { type?: unknown }).type !== 'plan') return undefined;
	const header = planHeader.safeParse(data);
	if (!header.success) throw new KalfaError(`${path}: the Plan frontmatter is not valid:\n${z.prettifyError(header.error)}`);
	const lineOffset = match[0].split('\n').length - (match[0].endsWith('\n') ? 1 : 0);
	const steps = readPlanSteps(normal.slice(match[0].length), lineOffset);
	return { path, title: header.data.title, status: header.data.status, ...steps };
}

export interface FoundPlans {
	plans: Plan[];
	/** One message per glob that matches nothing or page that cannot be read. */
	problems: string[];
}

const IGNORED = ['**/node_modules/**', `${PRIVATE_DIR}/**`];

/** The Plans that `globs` match under `root`, sorted by path. A broken page does not hide the others. */
export function findPlans(root: string, globs: readonly string[]): FoundPlans {
	const problems: string[] = [];
	const paths = new Set<string>();
	for (const glob of globs) {
		const matched = globSync(glob, { cwd: root, ignore: IGNORED, onlyFiles: true, expandDirectories: false });
		if (!matched.length) problems.push(`plans glob '${glob}' matches no file`);
		for (const path of matched) paths.add(path);
	}
	const plans: Plan[] = [];
	for (const path of [...paths].sort()) {
		try {
			const plan = parsePlan(readFileSync(join(root, path), 'utf8'), path);
			if (plan) plans.push(plan);
		} catch (error) {
			if (!(error instanceof KalfaError)) throw error;
			problems.push(error.message);
		}
	}
	return { plans, problems };
}

/** One line per open Plan: title, state, progress, path, and the next open step. */
export function planSummary(plan: Plan): string {
	const { done, total } = progressOf(plan.steps);
	const [next] = openAnywhere(plan.steps);
	const lines = [`- ${plan.title} (${plan.status}, ${done} of ${total} steps done; ${plan.path})`];
	if (next) {
		const [sub] = openAnywhere(next.subItems);
		lines.push(`  Next: ${clip(next.label)}${sub ? ` → ${clip(sub.label)}` : ''}`);
	}
	return lines.join('\n');
}

const clip = (text: string, max = 120) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
