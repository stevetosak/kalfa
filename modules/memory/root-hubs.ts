// The Root Hubs at session start (ADR 0003): each layer's Root Hub, a short
// map of the layer, loads in the session report in place of its index lines.
// A Root Hub over its limit loads cut, never refused: the Operator gets a
// notice and the lint names it. The Core finds the Root Hub (the record
// `root`, or the end of its supersede chain) and keeps room for it.
import type { Layer, LayerScan } from '../../src/core/memory/home.ts';
import type { MemoryRecord } from '../../src/core/memory/record.ts';
import { ROOT_HUB_ID, rootHubOf, rootRecord } from '../../src/core/memory/root-hub.ts';
import type { Finding } from './lint.ts';

export interface RootHubText {
	layer: Layer;
	record: MemoryRecord;
	/** What the session report loads: the whole Root Hub, or its start and a pointer line. */
	text: string;
	/** The whole Root Hub's length, heading included. */
	chars: number;
	cut: boolean;
}

const layerTitle = (layer: Layer) => (layer.name === 'personal' ? 'the Personal layer' : `the Project layer (${layer.label})`);

/** The whole Root Hub as the session report shows it: a heading, the summary and the body. */
function wholeText(layer: Layer, record: MemoryRecord): string {
	const heading = `Root Hub of ${layerTitle(layer)}; read a linked record with kalfa memory show <id> (kalfa memory show ${record.id} for this one):`;
	return [heading, record.header.summary, ...(record.body ? ['', record.body] : [])].join('\n');
}

/**
 * The start of `text` in at most `max` characters, cut at a line end so a
 * link is not split; at a word end when the last line end would keep less
 * than half the room.
 */
export function cutText(text: string, max: number): string {
	if (text.length <= max) return text;
	const head = text.slice(0, max + 1);
	const line = head.lastIndexOf('\n');
	if (line >= max / 2) return text.slice(0, line).trimEnd();
	const word = head.lastIndexOf(' ');
	return (word > 0 ? text.slice(0, word) : text.slice(0, max)).trimEnd();
}

/** A layer's Root Hub in at most `limit` characters; `undefined` when the layer has none. */
export function rootHubText(layer: Layer, records: readonly MemoryRecord[], limit: number): RootHubText | undefined {
	const record = rootHubOf(records);
	if (!record) return undefined;
	const whole = wholeText(layer, record);
	if (whole.length <= limit) return { layer, record, text: whole, chars: whole.length, cut: false };
	const pointer = `\n… cut at ${limit} characters: kalfa memory show ${record.id} has the rest`;
	return { layer, record, text: `${cutText(whole, Math.max(0, limit - pointer.length))}${pointer}`, chars: whole.length, cut: true };
}

/** The Root Hub faults of one layer: a root record that is not a Hub, and a Root Hub over its limit. */
export function rootHubFindings(layer: Layer, scan: LayerScan, limit: number): Finding[] {
	const root = rootRecord(scan.records);
	if (root?.header.status === 'active' && root.header.type !== 'hub') {
		return [
			{
				layer: layer.label,
				id: root.id,
				problem: `the layer's root record is a ${root.header.type}, not a hub: it does not load as the Root Hub, and the layer loads its index lines. The id '${ROOT_HUB_ID}' is kept for the Root Hub`,
			},
		];
	}
	const hub = rootHubText(layer, scan.records, limit);
	if (!hub?.cut) return [];
	return [
		{
			layer: layer.label,
			id: hub.record.id,
			problem: `the Root Hub is ${hub.chars} characters, over its limit of ${limit} (memory.root-hub-chars): the session start loads it cut. Keep it a short map: move detail into subject Hubs, then supersede it`,
		},
	];
}
