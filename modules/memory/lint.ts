// The lint: what in the layers needs the Operator's eye (ADR 0002). It only
// reports. A stale or doubtful record still loads, because old here often
// means rare but critical.
import type { Layer, LayerScan } from '../../src/core/memory/home.ts';
import type { MemoryRecord } from '../../src/core/memory/record.ts';
import { budgetProblem } from '../../src/core/memory/standing.ts';
import type { MemoryBudgets } from '../../src/core/settings.ts';
import { type Link, LinkGraph, type LinkNode, linkText, PERSONAL_PREFIX } from './links.ts';
import type { MemorySettings } from './settings.ts';
import { jaccard, wordsOf } from './words.ts';

export interface Finding {
	layer: string;
	id?: string;
	problem: string;
}

/** Two summaries that share this much of their words are likely one record twice. */
export const DUPLICATE_OVERLAP = 0.6;
const DAY_MS = 86_400_000;

const daysBetween = (from: string, to: string) => Math.floor((Date.parse(to) - Date.parse(from)) / DAY_MS);

export interface LintInput {
	scans: { layer: Layer; scan: LayerScan }[];
	budgets: MemoryBudgets;
	ageLimits: MemorySettings['age-limits'];
	/** `YYYY-MM-DD`. */
	today: string;
}

function recordFindings(layer: Layer, records: readonly MemoryRecord[], input: LintInput): Finding[] {
	const findings: Finding[] = [];
	const ids = new Set(records.map((r) => r.id));
	for (const record of records) {
		const { header } = record;
		const next = header['superseded-by'];
		if (next && !ids.has(next)) findings.push({ layer: layer.label, id: record.id, problem: `superseded-by '${next}' names no record in this layer` });
		if (header.status !== 'active') continue;
		const limit = input.ageLimits[header.type];
		const age = daysBetween(header.confirmed, input.today);
		if (limit !== null && age > limit) {
			findings.push({
				layer: layer.label,
				id: record.id,
				problem: `stale: last confirmed ${header.confirmed} (${age} days; a ${header.type} is checked every ${limit}). Confirm it with proof, or supersede it`,
			});
		}
	}
	const budget = budgetProblem(layer, records, input.budgets);
	if (budget) findings.push({ layer: layer.label, problem: budget });
	return findings;
}

/** Pairs of active records, across the layers, whose summaries say much the same. */
export function duplicateFindings(input: Pick<LintInput, 'scans'>): Finding[] {
	const active = input.scans.flatMap(({ layer, scan }) =>
		scan.records.filter((r) => r.header.status === 'active').map((record) => ({ layer, record, words: wordsOf(record.header.summary) })),
	);
	const findings: Finding[] = [];
	for (let i = 0; i < active.length; i++) {
		for (let j = i + 1; j < active.length; j++) {
			const a = active[i]!;
			const b = active[j]!;
			if (a.words.size < 2 || b.words.size < 2) continue;
			const overlap = jaccard(a.words, b.words);
			if (overlap < DUPLICATE_OVERLAP) continue;
			findings.push({
				layer: b.layer.label,
				id: b.record.id,
				problem: `likely a duplicate of ${a.layer.label}/${a.record.id} (${Math.round(overlap * 100)}% of the summary words are the same). Merge them with a supersede`,
			});
		}
	}
	return findings;
}

/** Why a link of `from` names no record: a link into a project, a wrong prefix or a missing record. */
function missingLinkProblem(graph: LinkGraph, from: LinkNode, link: Link, layers: readonly Layer[]): string {
	const text = linkText(link);
	const otherLayer = link.prefix !== undefined && link.prefix !== PERSONAL_PREFIX;
	// Another layer with the id of a link without a prefix: the prefix is likely wrong or missing.
	const holder = link.prefix === undefined ? layers.find((layer) => graph.find(layer, link.id)) : undefined;
	if (from.layer.name === 'personal' && (otherLayer || holder)) {
		// A personal record loads in every project; a link into one project is broken in all the others.
		const back = linkText({ prefix: PERSONAL_PREFIX, id: from.record.id });
		return `link into a project ${text}${holder ? ` (a record of ${holder.label})` : ''}: a personal record links only to personal records. Link the other way: ${back} in the project's record`;
	}
	if (otherLayer) return `broken link ${text}: '${link.prefix}' names no layer; only '${PERSONAL_PREFIX}:' does`;
	if (holder?.name === 'personal') {
		return `broken link ${text}: no record in this layer has that id, but the Personal layer has one: write ${linkText({ prefix: PERSONAL_PREFIX, id: link.id })}`;
	}
	const where = link.prefix === undefined ? 'this layer' : 'the Personal layer';
	return `broken link ${text}: no record in ${where} has that id. Correct the link with a supersede, or write the record it names`;
}

/**
 * Broken links, and links from a personal record into a project (ADR 0003),
 * of every record that still links: a superseded one leaves that to its successor.
 */
export function linkFindings(input: Pick<LintInput, 'scans'>): Finding[] {
	const graph = new LinkGraph(input.scans.map(({ layer, scan }) => ({ layer, records: scan.records })));
	const layers = input.scans.map((s) => s.layer);
	return input.scans.flatMap(({ layer, scan }) =>
		scan.records.flatMap((record) => {
			const node = graph.find(layer, record.id)!;
			return graph.links(node).flatMap((target) =>
				'missing' in target ? [{ layer: layer.label, id: record.id, problem: missingLinkProblem(graph, node, target.missing, layers) }] : [],
			);
		}),
	);
}

export function lint(input: LintInput): Finding[] {
	return [
		...input.scans.flatMap(({ layer, scan }) => [
			...scan.problems.map((problem) => ({ layer: layer.label, problem: `left out of every session: ${problem}` })),
			...recordFindings(layer, scan.records, input),
		]),
		...linkFindings(input),
		...duplicateFindings(input),
	];
}

export const findingLine = (f: Finding): string => `- ${f.layer}${f.id ? `/${f.id}` : ''}: ${f.problem}`;
