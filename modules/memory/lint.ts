// The lint: what in the layers needs the Operator's eye (ADR 0002). It only
// reports. A stale or doubtful record still loads, because old here often
// means rare but critical.
import type { Layer, LayerScan } from '../../src/core/memory/home.ts';
import type { MemoryRecord } from '../../src/core/memory/record.ts';
import { budgetProblem } from '../../src/core/memory/standing.ts';
import type { MemoryBudgets } from '../../src/core/settings.ts';
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

function duplicateFindings(input: LintInput): Finding[] {
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

export function lint(input: LintInput): Finding[] {
	return [
		...input.scans.flatMap(({ layer, scan }) => [
			...scan.problems.map((problem) => ({ layer: layer.label, problem: `left out of every session: ${problem}` })),
			...recordFindings(layer, scan.records, input),
		]),
		...duplicateFindings(input),
	];
}

export const findingLine = (f: Finding): string => `- ${f.layer}${f.id ? `/${f.id}` : ''}: ${f.problem}`;
