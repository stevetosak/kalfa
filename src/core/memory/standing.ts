// Standing memory: what each layer puts into a session, under its budget.
// Every active rule loads in full; facts, decisions and open items load as
// one index line each, the most recently confirmed first, until the layer's
// index bytes are used. Over budget, nothing is refused at a session's start:
// the rules all load, and the report names what was left out (ADR 0002).
import type { LayerBudget, MemoryBudgets } from '../settings.ts';
import type { Layer } from './home.ts';
import { type MemoryRecord, ruleText } from './record.ts';

export interface LayerView {
	layer: Layer;
	rules: MemoryRecord[];
	/** The index lines that fit the budget, in load order. */
	index: string[];
	/** Index lines left out by the budget. */
	dropped: number;
	/** Active records over the layer's limits. */
	overRules: number;
	indexBytes: number;
}

export const indexLine = (record: MemoryRecord): string => `- [${record.header.type}] ${record.header.summary} (${record.id})`;

export const bytes = (text: string): number => Buffer.byteLength(text, 'utf8');

const newestConfirmed = (a: MemoryRecord, b: MemoryRecord) =>
	b.header.confirmed.localeCompare(a.header.confirmed) || b.header.created.localeCompare(a.header.created) || a.id.localeCompare(b.id);

export function layerView(layer: Layer, records: readonly MemoryRecord[], budget: LayerBudget): LayerView {
	const active = records.filter((r) => r.header.status === 'active');
	const rules = active.filter((r) => r.header.type === 'rule');
	const index: string[] = [];
	let used = 0;
	let dropped = 0;
	for (const record of active.filter((r) => r.header.type !== 'rule').sort(newestConfirmed)) {
		const line = indexLine(record);
		const cost = bytes(line) + 1;
		if (used + cost > budget['index-bytes']) dropped += 1;
		else {
			index.push(line);
			used += cost;
		}
	}
	return { layer, rules, index, dropped, overRules: Math.max(0, rules.length - budget.rules), indexBytes: used };
}

/** The layer's budget from the machine settings. */
export function budgetOf(layer: Layer, budgets: MemoryBudgets): LayerBudget {
	return budgets[layer.name];
}

/**
 * Why a layer would break its budget once `records` are its records, or
 * `undefined` when it fits. The CLI refuses such a write; the agent then
 * supersedes or merges records first.
 */
export function budgetProblem(layer: Layer, records: readonly MemoryRecord[], budgets: MemoryBudgets): string | undefined {
	const budget = budgetOf(layer, budgets);
	const view = layerView(layer, records, budget);
	const problems: string[] = [];
	if (view.overRules) problems.push(`${view.rules.length} active rules (limit ${budget.rules})`);
	if (view.dropped) {
		const all = records.filter((r) => r.header.status === 'active' && r.header.type !== 'rule');
		const need = all.reduce((sum, r) => sum + bytes(indexLine(r)) + 1, 0);
		problems.push(`${need} B of index lines (limit ${budget['index-bytes']} B)`);
	}
	return problems.length ? `the ${layer.label} layer would hold ${problems.join(' and ')}` : undefined;
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
	return blocks.length ? `${title}\n${blocks.join('\n\n')}` : '';
}

/** One line for the Operator when a layer is over its budget. */
export function overBudgetNotice(view: LayerView, budget: LayerBudget): string | undefined {
	const parts: string[] = [];
	if (view.overRules) parts.push(`${view.rules.length} rules, limit ${budget.rules} (all loaded; move or merge rules)`);
	if (view.dropped) parts.push(`${view.dropped} index line(s) left out (limit ${budget['index-bytes']} B)`);
	return parts.length ? `kalfa: memory: the ${view.layer.label} layer is over budget: ${parts.join('; ')}` : undefined;
}
