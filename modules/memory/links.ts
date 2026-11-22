// Links between Memory records (ADR 0003). `[[id]]` in a record's body names a
// record of its own layer, `[[personal:id]]` one of the Personal layer. Links
// are untyped: the sentence around a link says why it is there. Back-links are
// not stored: they are found when the records are read, so a write never has
// to change the record it links to.
import type { Layer } from '../../src/core/memory/home.ts';
import type { MemoryRecord } from '../../src/core/memory/record.ts';

/** One link as written: an optional layer prefix (only `personal` names a layer) and the id. */
export interface Link {
	prefix?: string;
	id: string;
}

const CODE = /```[\s\S]*?```|`[^`\n]*`/g;
const LINK = /\[\[(?:([a-z][a-z0-9./-]*):)?([a-z0-9][a-z0-9-]{0,79})\]\]/g;

export const linkText = (link: Link): string => `[[${link.prefix ? `${link.prefix}:` : ''}${link.id}]]`;

/** The links of a body, each once, in order. A link inside code is an example, not a link. */
export function parseLinks(body: string): Link[] {
	const seen = new Set<string>();
	const links: Link[] = [];
	for (const match of body.replace(CODE, '').matchAll(LINK)) {
		const link: Link = match[1] ? { prefix: match[1], id: match[2]! } : { id: match[2]! };
		const text = linkText(link);
		if (seen.has(text)) continue;
		seen.add(text);
		links.push(link);
	}
	return links;
}

export interface LayerRecords {
	layer: Layer;
	records: readonly MemoryRecord[];
}

export interface LinkNode {
	layer: Layer;
	record: MemoryRecord;
}

/** Where a link points: a record, or nothing (the link as written). */
export type LinkTarget = { node: LinkNode } | { missing: string };

/** One neighbour in `show`'s tree: `out` the record links to it, `in` it links to the record. */
export interface Neighbour {
	direction: 'out' | 'in';
	target: LinkTarget;
	/** Its own neighbours one level deeper; each record appears once, where it is first reached. */
	next: Neighbour[];
}

const keyOf = (layer: Layer, id: string) => `${layer.label}\0${id}`;

/** The links of the records of the layers a directory sees, both ways. */
export class LinkGraph {
	private readonly nodes = new Map<string, LinkNode>();
	private readonly back = new Map<string, LinkNode[]>();
	private readonly personal: Layer | undefined;

	constructor(layers: readonly LayerRecords[]) {
		this.personal = layers.find((l) => l.layer.name === 'personal')?.layer;
		for (const { layer, records } of layers) for (const record of records) this.nodes.set(keyOf(layer, record.id), { layer, record });
		for (const node of this.nodes.values()) {
			for (const target of this.links(node)) {
				if (!('node' in target)) continue;
				const key = keyOf(target.node.layer, target.node.record.id);
				this.back.set(key, [...(this.back.get(key) ?? []), node]);
			}
		}
	}

	find(layer: Layer, id: string): LinkNode | undefined {
		return this.nodes.get(keyOf(layer, id));
	}

	/** What the record links to. A superseded record links to nothing: its successor holds the current text. */
	links(node: LinkNode): LinkTarget[] {
		if (node.record.header.status === 'superseded') return [];
		return parseLinks(node.record.body).map((link) => {
			const layer = link.prefix === undefined ? node.layer : link.prefix === 'personal' ? this.personal : undefined;
			const target = layer && this.find(layer, link.id);
			return target ? { node: target } : { missing: linkText(link) };
		});
	}

	/** The records that link to this one. */
	backLinks(node: LinkNode): LinkNode[] {
		return this.back.get(keyOf(node.layer, node.record.id)) ?? [];
	}

	/** The neighbours of `start` to `depth` levels, breadth first, so each record appears at the first level that reaches it. */
	neighbourhood(start: LinkNode, depth: number): Neighbour[] {
		const seen = new Set([keyOf(start.layer, start.record.id)]);
		const step = (node: LinkNode): Neighbour[] => {
			const fresh = (n: LinkNode) => {
				const key = keyOf(n.layer, n.record.id);
				if (seen.has(key)) return false;
				seen.add(key);
				return true;
			};
			const out = this.links(node).filter((t) => !('node' in t) || fresh(t.node));
			const back = this.backLinks(node).filter(fresh);
			return [...out.map((target) => ({ direction: 'out' as const, target, next: [] })), ...back.map((n) => ({ direction: 'in' as const, target: { node: n }, next: [] }))];
		};
		if (depth < 1) return [];
		const tree = step(start);
		let frontier = tree;
		for (let level = 2; level <= depth; level++) {
			const deeper: Neighbour[] = [];
			for (const item of frontier) {
				if (!('node' in item.target)) continue;
				item.next = step(item.target.node);
				deeper.push(...item.next);
			}
			frontier = deeper;
		}
		return tree;
	}
}

/** One summary line per neighbour, indented by level; `from` is the record shown, whose layer goes unnamed. */
export function neighbourLines(from: LinkNode, tree: readonly Neighbour[], indent = ''): string[] {
	return tree.flatMap((item) => {
		const arrow = item.direction === 'out' ? '→' : '←';
		if (!('node' in item.target)) return [`${indent}- ${arrow} ${item.target.missing}: no such record`];
		const { layer, record } = item.target.node;
		const { type, status, summary } = record.header;
		const mark = status === 'active' ? '' : status === 'superseded' ? `, superseded by ${record.header['superseded-by']}` : `, ${status}`;
		const where = layer.label === from.layer.label ? record.id : `${record.id}, ${layer.label}`;
		return [`${indent}- ${arrow} [${type}${mark}] ${summary} (${where})`, ...neighbourLines(from, item.next, `${indent}  `)];
	});
}
