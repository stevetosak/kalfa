// Standing memory: what each layer puts into a session, under its budget
// (ADR 0002, amendment 2026-11-08). A layer has two tiers. The Loaded tier is
// every active rule in full and the index lines that fit the layer's bytes,
// the most recently used or confirmed first. The Stored tier is every other
// active record: kept, searchable, and named at the session start. A budget
// decides only what loads; nothing is ever refused for space.
import type { LayerBudget, MemoryBudgets } from '../settings.ts';
import type { Layer } from './home.ts';
import { type MemoryRecord, ruleText } from './record.ts';
import type { Usage } from './usage.ts';

export interface LayerView {
	layer: Layer;
	rules: MemoryRecord[];
	/** The Loaded index lines, in load order. */
	index: string[];
	/** The Stored tier: active records whose index line did not fit, in rank order. */
	stored: MemoryRecord[];
	/** Active rules over the layer's rule count (they all load). */
	overRules: number;
	indexBytes: number;
}

export const indexLine = (record: MemoryRecord): string => `- [${record.header.type}] ${record.header.summary} (${record.id})`;

export const bytes = (text: string): number => Buffer.byteLength(text, 'utf8');

/** The day a record ranks by: the later of its last use and its last confirmation. */
export const rankDay = (record: MemoryRecord, usage: Usage): string => {
	const used = usage[record.id];
	return used && used > record.header.confirmed ? used : record.header.confirmed;
};

const byRank = (usage: Usage) => (a: MemoryRecord, b: MemoryRecord) =>
	rankDay(b, usage).localeCompare(rankDay(a, usage)) || b.header.created.localeCompare(a.header.created) || a.id.localeCompare(b.id);

export function layerView(layer: Layer, records: readonly MemoryRecord[], budget: LayerBudget, usage: Usage = {}): LayerView {
	const active = records.filter((r) => r.header.status === 'active');
	const rules = active.filter((r) => r.header.type === 'rule');
	const index: string[] = [];
	const stored: MemoryRecord[] = [];
	let used = 0;
	for (const record of active.filter((r) => r.header.type !== 'rule').sort(byRank(usage))) {
		const line = indexLine(record);
		const cost = bytes(line) + 1;
		if (used + cost > budget['index-bytes']) stored.push(record);
		else {
			index.push(line);
			used += cost;
		}
	}
	return { layer, rules, index, stored, overRules: Math.max(0, rules.length - budget.rules), indexBytes: used };
}

/** The layer's budget from the machine settings. */
export function budgetOf(layer: Layer, budgets: MemoryBudgets): LayerBudget {
	return budgets[layer.name];
}

/**
 * How far a layer is over its budget, or `undefined` when everything loads.
 * Never a reason to refuse a write: the lint and the upkeep at Task close
 * report it.
 */
export function budgetProblem(layer: Layer, records: readonly MemoryRecord[], budgets: MemoryBudgets): string | undefined {
	const budget = budgetOf(layer, budgets);
	const view = layerView(layer, records, budget);
	const problems: string[] = [];
	if (view.overRules) problems.push(`${view.rules.length} active rules (limit ${budget.rules})`);
	if (view.stored.length) {
		const all = records.filter((r) => r.header.status === 'active' && r.header.type !== 'rule');
		const need = all.reduce((sum, r) => sum + bytes(indexLine(r)) + 1, 0);
		problems.push(`${need} B of index lines (limit ${budget['index-bytes']} B; ${view.stored.length} Stored)`);
	}
	return problems.length ? `the ${layer.label} layer holds ${problems.join(' and ')}` : undefined;
}

function indent(text: string): string {
	return text
		.split('\n')
		.map((line) => (line ? `  ${line}` : line))
		.join('\n');
}

/** The text one layer injects; empty when it holds nothing active. */
export function renderLayer(view: LayerView): string {
	const title = view.layer.name === 'personal' ? 'Personal layer' : `Project layer (${view.layer.label})`;
	const blocks: string[] = [];
	if (view.rules.length) blocks.push(['Rules:', ...view.rules.map((r) => `- ${indent(ruleText(r)).trimStart()} (${r.id})`)].join('\n'));
	if (view.index.length) blocks.push(['Index (the body: kalfa memory show <id>):', ...view.index].join('\n'));
	if (view.stored.length) {
		const n = view.stored.length;
		blocks.push(
			`Stored: ${n} more active record${n === 1 ? '' : 's'}, not loaded; recall searches them. Before you rely on memory for a subject, run \`kalfa memory search "<words>"\` (or \`kalfa memory list --layer ${view.layer.name}\`).`,
		);
	}
	return blocks.length ? `${title}\n${blocks.join('\n\n')}` : '';
}

/** One line for the Operator when a layer's rules are over their count; the Stored tier is normal and needs no line. */
export function overBudgetNotice(view: LayerView, budget: LayerBudget): string | undefined {
	if (!view.overRules) return undefined;
	return `kalfa: memory: the ${view.layer.label} layer has ${view.rules.length} rules, limit ${budget.rules} (all loaded; the upkeep at Task close proposes merges)`;
}
