// The record subcommands of `kalfa memory`: the only way the agent writes a
// Memory record (ADR 0002, 0003). Each write is checked, dated and committed in
// the Memory home, which the Core owns with the record format. A write is
// never refused for space: a budget decides only what loads, and a record
// past it is Stored (amendment 2026-11-08). What the Operator states and what
// the agent finds are written at once and active; a rule goes to its Rule pack
// through `kalfa rule` (ADR 0003).
import { existsSync, readFileSync } from 'node:fs';
import { parseCommandArgs, UsageError } from '../../src/cli/command.ts';
import type { Io } from '../../src/cli/io.ts';
import { layerFor, layerName, layersFor } from '../../src/cli/layers.ts';
import { KalfaError } from '../../src/core/errors.ts';
import { type HomeChange, type Layer, type LayerName, memoryHome, readLayer, recordHistory, recordPath, writeRecords } from '../../src/core/memory/home.ts';
import {
	checkHeader,
	isNewRecordType,
	type MemoryRecord,
	NEW_RECORD_TYPES,
	type NewRecordType,
	newRecordHeader,
	RECORD_STATUSES,
	RULE_IS_NOT_MEMORY,
	slugOf,
} from '../../src/core/memory/record.ts';
import { ROOT_HUB_ID } from '../../src/core/memory/root-hub.ts';
import { markUsed } from '../../src/core/memory/usage.ts';
import { LinkGraph, neighbourLines } from './links.ts';

const today = () => new Date().toLocaleDateString('sv-SE');

const layerOption = { layer: { type: 'string' } } as const;

function findRecord(io: Io, id: string, name: LayerName | undefined): { layer: Layer; record: MemoryRecord; records: MemoryRecord[] } {
	const found = layersFor(io, name).flatMap((layer) => {
		const records = readLayer(layer);
		const record = records.find((r) => r.id === id);
		return record ? [{ layer, record, records }] : [];
	});
	if (!found.length) throw new KalfaError(`no Memory record '${id}'${name ? ` in the ${name} layer` : ''} (kalfa memory list)`);
	if (found.length > 1) throw new KalfaError(`'${id}' is in more than one layer; name one with --layer personal|project`);
	return found[0]!;
}

/**
 * The id of a new record: the one asked for, else one from the summary that
 * no record has. The Root Hub's id is kept for a Hub, so the layer's map is
 * never a record of another type.
 */
function newId(records: readonly MemoryRecord[], type: NewRecordType, summary: string, asked: string | undefined): string {
	if (asked === ROOT_HUB_ID && type !== 'hub') throw new UsageError(`the id '${ROOT_HUB_ID}' is kept for the layer's Root Hub: give --type hub, or another id`);
	const taken = new Set(records.map((r) => r.id));
	if (asked) return asked;
	if (type !== 'hub') taken.add(ROOT_HUB_ID);
	const wanted = slugOf(summary);
	if (!taken.has(wanted)) return wanted;
	for (let n = 2; ; n++) if (!taken.has(`${wanted}-${n}`)) return `${wanted}-${n}`;
}

/** Refuses a write to a record that no longer counts: superseded or closed. */
function refuseRetired(record: MemoryRecord, action: string): void {
	const { status } = record.header;
	if (status === 'superseded') throw new KalfaError(`'${record.id}' is already superseded by '${record.header['superseded-by']}'; ${action} that one`);
	if (status === 'closed') throw new KalfaError(`'${record.id}' is closed; add a new record instead`);
}

const LINK_DEPTHS = [0, 1, 2];

/** Parses a --depth value: how many levels of linked records `show` lists; 1 when not given. */
function linkDepth(value: string | undefined): number {
	if (value === undefined) return 1;
	const depth = LINK_DEPTHS.find((d) => String(d) === value);
	if (depth === undefined) throw new UsageError(`--depth is ${LINK_DEPTHS.join(', ')}, not '${value}'`);
	return depth;
}

/** Parses a --type value: a type a write can make. */
export function recordType(value: string | undefined): NewRecordType {
	if (!value) throw new UsageError(`give --type (${NEW_RECORD_TYPES.join(', ')})`);
	if (value === 'rule') throw new UsageError(RULE_IS_NOT_MEMORY);
	if (!isNewRecordType(value)) throw new UsageError(`--type is one of ${NEW_RECORD_TYPES.join(', ')}, not '${value}'`);
	return value;
}

export interface NewRecord {
	type: NewRecordType;
	summary: string | undefined;
	source?: string;
	id?: string;
	body?: string;
}

/**
 * Checks and writes one new active record in `layer` as one commit, with any
 * other change of the Memory home (`also`, e.g. the inbox file it came from).
 * Never refused for space.
 */
export function addRecord(io: Io, layer: Layer, input: NewRecord, also: HomeChange = {}): MemoryRecord & { layer: Layer; path: string } {
	if (!input.summary?.trim()) throw new UsageError('give --summary "<one line>"');
	const records = readLayer(layer);
	if (input.id && records.some((r) => r.id === input.id)) throw new KalfaError(`'${input.id}' already exists in the ${layer.label} layer`);
	const header = newRecordHeader({ type: input.type, summary: input.summary, source: input.source }, today());
	const record: MemoryRecord = { id: newId(records, input.type, header.summary, input.id), header, body: (input.body ?? '').trim() };
	const [path] = writeRecords(memoryHome(io.env), [{ layer, record }], `add ${input.type} ${record.id} (${layer.label})`, also);
	return { ...record, layer, path: path! };
}

/** A subcommand of `kalfa memory`. */
export type MemorySubcommand = (args: string[], io: Io) => Promise<number>;

/** add, supersede, confirm, close, activate, show and list. */
export const recordSubcommands: Record<string, MemorySubcommand> = {
	async add(args, io) {
		const { values } = parseCommandArgs(args, {
			...layerOption,
			type: { type: 'string' },
			summary: { type: 'string' },
			source: { type: 'string' },
			id: { type: 'string' },
			// Read only to refuse it with its reason: an older instruction may still name it.
			proposed: { type: 'boolean' },
		});
		if (values.proposed) throw new UsageError('--proposed is gone (ADR 0003): the agent writes what it finds as an active record, and the Operator does not review it');
		const type = recordType(values.type);
		const name = layerName(values.layer);
		if (!name) throw new UsageError('give --layer personal or --layer project');
		const record = addRecord(io, layerFor(io, name), { type, summary: values.summary, source: values.source, id: values.id, body: await io.stdin() });
		io.out(`Added ${type} ${record.id} in the ${record.layer.label} layer: ${record.path}`);
		return 0;
	},

	async supersede(args, io) {
		const { values, positionals } = parseCommandArgs(args, { ...layerOption, summary: { type: 'string' }, id: { type: 'string' } }, true);
		const [oldId, ...extra] = positionals;
		if (!oldId || extra.length) throw new UsageError('give the id of the record to supersede');
		if (!values.summary?.trim()) throw new UsageError('give --summary "<one line>" for the new record');
		const { layer, record: old, records } = findRecord(io, oldId, layerName(values.layer));
		refuseRetired(old, 'supersede');
		const { type } = old.header;
		if (!isNewRecordType(type)) throw new KalfaError(`'${old.id}' is a rule record, and ${RULE_IS_NOT_MEMORY}; kalfa rule migrate moves this one into its Rule pack`);
		// The successor is active, also for a proposed record: the supersede decides it.
		const next: MemoryRecord = {
			id: newId(records, type, values.summary, values.id),
			header: newRecordHeader({ type, summary: values.summary, source: old.header.source }, today()),
			body: (await io.stdin()).trim(),
		};
		if (records.some((r) => r.id === next.id)) throw new KalfaError(`'${next.id}' already exists in the ${layer.label} layer`);
		const retired: MemoryRecord = { ...old, header: checkHeader({ ...old.header, status: 'superseded', 'superseded-by': next.id }) };
		writeRecords(
			memoryHome(io.env),
			[
				{ layer, record: next },
				{ layer, record: retired },
			],
			`supersede ${old.id} with ${next.id} (${layer.label})`,
		);
		io.out(`${next.id} supersedes ${old.id} in the ${layer.label} layer`);
		return 0;
	},

	async confirm(args, io) {
		const { values, positionals } = parseCommandArgs(args, layerOption, true);
		const [id, ...proofWords] = positionals;
		const proof = proofWords.join(' ').trim();
		if (!id || !proof) throw new UsageError('give the id and the proof: kalfa memory confirm <id> "<how you checked it>"');
		const { layer, record } = findRecord(io, id, layerName(values.layer));
		refuseRetired(record, 'confirm');
		const confirmed: MemoryRecord = { ...record, header: { ...record.header, confirmed: today() } };
		writeRecords(memoryHome(io.env), [{ layer, record: confirmed }], `confirm ${id}: ${proof.replace(/\s+/g, ' ')}`);
		io.out(`Confirmed ${id} (${layer.label}) on ${confirmed.header.confirmed}`);
		return 0;
	},

	/**
	 * A record whose work is done, or that no longer applies, is closed: it
	 * leaves the session start; its file, history and search hit stay. The
	 * reason goes into the history, as a confirm's proof does.
	 */
	async close(args, io) {
		const { values, positionals } = parseCommandArgs(args, layerOption, true);
		const [id, ...reasonWords] = positionals;
		const reason = reasonWords.join(' ').trim();
		if (!id || !reason) throw new UsageError('give the id and the reason: kalfa memory close <id> "<why it is done>"');
		const { layer, record } = findRecord(io, id, layerName(values.layer));
		refuseRetired(record, 'close');
		const closed: MemoryRecord = { ...record, header: checkHeader({ ...record.header, status: 'closed' }) };
		writeRecords(memoryHome(io.env), [{ layer, record: closed }], `close ${id}: ${reason.replace(/\s+/g, ' ')}`);
		io.out(`Closed ${id} (${layer.label})`);
		return 0;
	},

	/**
	 * Proposed records become active: the named ones, or every proposed record
	 * of the layers in scope. The Operator's review is the check, so the
	 * confirmed date is today. One commit per layer.
	 */
	async activate(args, io) {
		const { values, positionals } = parseCommandArgs(args, layerOption, true);
		const ids: string[] = positionals;
		const plans = layersFor(io, layerName(values.layer)).map((layer) => {
			const records = readLayer(layer);
			const chosen = records.filter((r) => r.header.status === 'proposed' && (!ids.length || ids.includes(r.id)));
			return { layer, chosen };
		});
		const found = new Set(plans.flatMap((p) => p.chosen.map((r) => r.id)));
		const missing = ids.filter((id) => !found.has(id));
		if (missing.length) throw new KalfaError(`no proposed record ${missing.map((id) => `'${id}'`).join(', ')} here (kalfa memory list --status proposed)`);
		const date = today();
		const writes = plans
			.filter((p) => p.chosen.length)
			.map(({ layer, chosen }) => ({ layer, active: chosen.map((r): MemoryRecord => ({ ...r, header: { ...r.header, status: 'active', confirmed: date } })) }));
		if (!writes.length) {
			io.out('no proposed records here');
			return 0;
		}
		for (const { layer, active } of writes) {
			writeRecords(memoryHome(io.env), active.map((record) => ({ layer, record })), `activate ${active.length} proposed record(s) (${layer.label})`);
			io.out(`Activated ${active.length} record(s) in the ${layer.label} layer`);
		}
		return 0;
	},

	/**
	 * The record in full, the summary line of each record it links to or that
	 * links to it (to --depth levels), and its history. Only the record shown
	 * counts as used: a summary line is not a read.
	 */
	async show(args, io) {
		const { values, positionals } = parseCommandArgs(args, { ...layerOption, depth: { type: 'string' } }, true);
		const [id, ...extra] = positionals;
		if (!id || extra.length) throw new UsageError('give one id');
		const depth = linkDepth(values.depth);
		const { layer } = findRecord(io, id, layerName(values.layer));
		markUsed(layer, [id], io.env);
		const path = recordPath(layer, id);
		const graph = new LinkGraph(layersFor(io, undefined).map((l) => ({ layer: l, records: readLayer(l) })));
		const node = graph.find(layer, id)!;
		const links = neighbourLines(node, graph.neighbourhood(node, depth));
		const history = recordHistory(memoryHome(io.env), path, id);
		io.out(
			[
				`${path} (${layer.label})\n\n${readFileSync(path, 'utf8').trimEnd()}`,
				...(links.length ? [`Links, depth ${depth} (→ it links to, ← links to it):\n${links.join('\n')}`] : []),
				...(history.length ? [`History:\n${history.map((h) => `- ${h}`).join('\n')}`] : []),
			].join('\n\n'),
		);
		return 0;
	},

	async list(args, io) {
		const { values } = parseCommandArgs(args, { ...layerOption, status: { type: 'string' } });
		const status = values.status ?? 'active';
		if (status !== 'all' && !(RECORD_STATUSES as readonly string[]).includes(status)) throw new UsageError(`--status is all or one of ${RECORD_STATUSES.join(', ')}`);
		let shown = 0;
		for (const layer of layersFor(io, layerName(values.layer))) {
			const records = readLayer(layer).filter((r) => status === 'all' || r.header.status === status);
			if (!records.length) continue;
			io.out(`${layer.label}:`);
			for (const r of records) io.out(`  ${r.id}  ${r.header.type}  ${r.header.status}  confirmed ${r.header.confirmed}  ${r.header.summary}`);
			shown += records.length;
		}
		if (!shown) io.out(existsSync(memoryHome(io.env)) ? `no ${status === 'all' ? '' : `${status} `}Memory records here` : 'no Memory home yet; kalfa memory add creates it');
		return 0;
	},
};

/** The usage lines of the record subcommands. */
export const RECORD_USAGE = [
	'kalfa memory add --type fact|decision|open|hub --layer personal|project --summary "<one line>" [--source <link>] [--id <id>]   (body on stdin, optional; a rule: kalfa rule add)',
	'kalfa memory supersede <id> --summary "<one line>" [--layer …] [--id <id>]   (body on stdin, optional)',
	'kalfa memory confirm <id> "<how you checked it>" [--layer …]',
	'kalfa memory close <id> "<why it is done>" [--layer …]   (it leaves the session start; search keeps it)',
	'kalfa memory activate [<id>…] [--layer …]   (the proposed records of the old review become active; no id: all of them)',
	'kalfa memory show <id> [--layer …] [--depth 0|1|2]   (with the summary line of each linked record, to depth 1 when not given)',
	'kalfa memory list [--layer personal|project] [--status active|proposed|superseded|closed|all]',
];
