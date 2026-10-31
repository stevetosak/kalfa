// `kalfa memory`: the only way the agent writes a Memory record (ADR 0002).
// Each write is checked, dated, refused when it takes a layer over its
// Standing-memory budget, and committed in the Memory home. What the Operator
// states is written at once; what the agent finds goes through a Memory
// candidate first (the `memory` Module's part, not this command's).
import { existsSync, readFileSync } from 'node:fs';
import { KalfaError } from '../../core/errors.ts';
import {
	type HomeChange,
	type Layer,
	type LayerName,
	memoryHome,
	personalLayer,
	projectLayer,
	readLayer,
	recordHistory,
	recordPath,
	sessionLayers,
	writeRecords,
} from '../../core/memory/home.ts';
import { checkHeader, type MemoryRecord, RECORD_STATUSES, RECORD_TYPES, type RecordHeader, type RecordType, ruleText, slugOf } from '../../core/memory/record.ts';
import { budgetProblem } from '../../core/memory/standing.ts';
import { loadProject } from '../../core/project.ts';
import { loadSettings, memoryBudgets } from '../../core/settings.ts';
import { type Command, parseCommandArgs, UsageError } from '../command.ts';
import type { Io } from '../io.ts';

const today = () => new Date().toLocaleDateString('sv-SE');

const layerOption = { layer: { type: 'string' } } as const;

/** Parses a --layer value. */
export function layerName(value: string | undefined): LayerName | undefined {
	if (value === undefined) return undefined;
	if (value !== 'personal' && value !== 'project') throw new UsageError(`--layer is personal or project, not '${value}'`);
	return value;
}

function layerFor(io: Io, name: LayerName): Layer {
	const home = memoryHome(io.env);
	if (name === 'personal') return personalLayer(home);
	const project = loadProject(io.cwd);
	if (!project) throw new KalfaError('the project layer needs a git repository; run this inside one, or use --layer personal');
	return projectLayer(home, project);
}

/** The layers to look in for an id: the one named, else every layer this directory sees. */
function layersFor(io: Io, name: LayerName | undefined): Layer[] {
	return name ? [layerFor(io, name)] : sessionLayers(memoryHome(io.env), loadProject(io.cwd));
}

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

function uniqueId(records: readonly MemoryRecord[], wanted: string): string {
	const taken = new Set(records.map((r) => r.id));
	if (!taken.has(wanted)) return wanted;
	for (let n = 2; ; n++) if (!taken.has(`${wanted}-${n}`)) return `${wanted}-${n}`;
}

function checkRule(record: MemoryRecord, io: Io): void {
	if (record.header.type !== 'rule') return;
	const limit = memoryBudgets(loadSettings(io.env)).ruleChars;
	const length = ruleText(record).length;
	if (length > limit) throw new KalfaError(`a rule is short and exact: this one is ${length} characters (limit ${limit}); move the reasons into a fact or decision`);
}

function checkBudget(io: Io, layer: Layer, records: readonly MemoryRecord[]): void {
	const problem = budgetProblem(layer, records, memoryBudgets(loadSettings(io.env)));
	if (problem) throw new KalfaError(`refused: ${problem}. Supersede or merge records first (kalfa memory list --layer ${layer.name})`);
}

/** Refuses a write to a record that no longer counts: superseded or closed. */
function refuseRetired(record: MemoryRecord, action: string): void {
	const { status } = record.header;
	if (status === 'superseded') throw new KalfaError(`'${record.id}' is already superseded by '${record.header['superseded-by']}'; ${action} that one`);
	if (status === 'closed') throw new KalfaError(`'${record.id}' is closed; add a new record instead`);
}

const replace = (records: readonly MemoryRecord[], next: MemoryRecord) => [...records.filter((r) => r.id !== next.id), next];

/** Parses a --type value. */
export function recordType(value: string | undefined): RecordType {
	if (!value) throw new UsageError(`give --type (${RECORD_TYPES.join(', ')})`);
	if (!(RECORD_TYPES as readonly string[]).includes(value)) throw new UsageError(`--type is one of ${RECORD_TYPES.join(', ')}, not '${value}'`);
	return value as RecordType;
}

export interface NewRecord {
	type: RecordType;
	summary: string | undefined;
	source?: string;
	id?: string;
	proposed?: boolean;
	body?: string;
}

/**
 * Checks and writes one new record in `layer` as one commit, with any other
 * change of the Memory home (`also`, e.g. the inbox file it came from).
 * Refused over the rule length or the layer's budget.
 */
export function addRecord(io: Io, layer: Layer, input: NewRecord, also: HomeChange = {}): MemoryRecord & { layer: Layer; path: string } {
	if (!input.summary?.trim()) throw new UsageError('give --summary "<one line>"');
	const records = readLayer(layer);
	if (input.id && records.some((r) => r.id === input.id)) throw new KalfaError(`'${input.id}' already exists in the ${layer.label} layer`);
	const date = today();
	const header: RecordHeader = checkHeader({
		schema: 1,
		type: input.type,
		status: input.proposed ? 'proposed' : 'active',
		summary: input.summary,
		created: date,
		confirmed: date,
		...(input.source ? { source: input.source } : {}),
	});
	const record: MemoryRecord = { id: input.id ?? uniqueId(records, slugOf(header.summary)), header, body: (input.body ?? '').trim() };
	checkRule(record, io);
	checkBudget(io, layer, [...records, record]);
	const [path] = writeRecords(memoryHome(io.env), [{ layer, record }], `add ${input.type} ${record.id} (${layer.label})`, also);
	return { ...record, layer, path: path! };
}

/** A subcommand of `kalfa memory`; a Module can add its own (the `memory` Module adds search, lint, inbox). */
export type MemorySubcommand = (args: string[], io: Io) => Promise<number>;

const subcommands: Record<string, MemorySubcommand> = {
	async add(args, io) {
		const { values } = parseCommandArgs(args, {
			...layerOption,
			type: { type: 'string' },
			summary: { type: 'string' },
			source: { type: 'string' },
			id: { type: 'string' },
			proposed: { type: 'boolean' },
		});
		const type = recordType(values.type);
		const name = layerName(values.layer);
		if (!name) throw new UsageError('give --layer personal or --layer project');
		const record = addRecord(io, layerFor(io, name), { type, summary: values.summary, source: values.source, id: values.id, proposed: values.proposed, body: await io.stdin() });
		io.out(`${record.header.status === 'proposed' ? 'Proposed' : 'Added'} ${type} ${record.id} in the ${record.layer.label} layer: ${record.path}`);
		return 0;
	},

	async supersede(args, io) {
		const { values, positionals } = parseCommandArgs(args, { ...layerOption, summary: { type: 'string' }, id: { type: 'string' } }, true);
		const [oldId, ...extra] = positionals;
		if (!oldId || extra.length) throw new UsageError('give the id of the record to supersede');
		if (!values.summary?.trim()) throw new UsageError('give --summary "<one line>" for the new record');
		const { layer, record: old, records } = findRecord(io, oldId, layerName(values.layer));
		refuseRetired(old, 'supersede');
		const date = today();
		const next: MemoryRecord = {
			id: values.id ?? uniqueId(records, slugOf(values.summary)),
			header: checkHeader({
				schema: 1,
				type: old.header.type,
				status: old.header.status,
				summary: values.summary,
				created: date,
				confirmed: date,
				...(old.header.source ? { source: old.header.source } : {}),
			}),
			body: (await io.stdin()).trim(),
		};
		if (records.some((r) => r.id === next.id)) throw new KalfaError(`'${next.id}' already exists in the ${layer.label} layer`);
		const retired: MemoryRecord = { ...old, header: checkHeader({ ...old.header, status: 'superseded', 'superseded-by': next.id }) };
		checkRule(next, io);
		checkBudget(io, layer, [...replace(records, retired), next]);
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
	 * confirmed date is today. Every layer's budget is checked before anything
	 * is written; then one commit per layer.
	 */
	async activate(args, io) {
		const { values, positionals } = parseCommandArgs(args, layerOption, true);
		const ids: string[] = positionals;
		const plans = layersFor(io, layerName(values.layer)).map((layer) => {
			const records = readLayer(layer);
			const chosen = records.filter((r) => r.header.status === 'proposed' && (!ids.length || ids.includes(r.id)));
			return { layer, records, chosen };
		});
		const found = new Set(plans.flatMap((p) => p.chosen.map((r) => r.id)));
		const missing = ids.filter((id) => !found.has(id));
		if (missing.length) throw new KalfaError(`no proposed record ${missing.map((id) => `'${id}'`).join(', ')} here (kalfa memory list --status proposed)`);
		const date = today();
		const writes = plans
			.filter((p) => p.chosen.length)
			.map(({ layer, records, chosen }) => {
				const active = chosen.map((r): MemoryRecord => ({ ...r, header: { ...r.header, status: 'active', confirmed: date } }));
				const byId = new Map(active.map((r) => [r.id, r]));
				checkBudget(io, layer, records.map((r) => byId.get(r.id) ?? r));
				return { layer, active };
			});
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

	async show(args, io) {
		const { values, positionals } = parseCommandArgs(args, layerOption, true);
		const [id, ...extra] = positionals;
		if (!id || extra.length) throw new UsageError('give one id');
		const { layer } = findRecord(io, id, layerName(values.layer));
		const path = recordPath(layer, id);
		const history = recordHistory(memoryHome(io.env), path, id);
		io.out(`${path} (${layer.label})\n\n${readFileSync(path, 'utf8').trimEnd()}${history.length ? `\n\nHistory:\n${history.map((h) => `- ${h}`).join('\n')}` : ''}`);
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

const CORE_USAGE = [
	'kalfa memory add --type rule|fact|decision|open --layer personal|project --summary "<one line>" [--source <link>] [--id <id>] [--proposed]   (body on stdin, optional)',
	'       kalfa memory supersede <id> --summary "<one line>" [--layer …] [--id <id>]   (body on stdin, optional)',
	'       kalfa memory confirm <id> "<how you checked it>" [--layer …]',
	'       kalfa memory close <id> "<why it is done>" [--layer …]   (it leaves the session start; search keeps it)',
	'       kalfa memory activate [<id>…] [--layer …]   (proposed records become active; no id: all of them)',
	'       kalfa memory show <id> [--layer …]',
	'       kalfa memory list [--layer personal|project] [--status active|proposed|superseded|closed|all]',
];

/** A Module's additions to `kalfa memory`: its subcommands and their usage lines. */
export interface MemoryExtension {
	subcommands: Record<string, MemorySubcommand>;
	usage: string[];
}

/** `kalfa memory`: the Core's subcommands, and those the Modules add (a Core name cannot be taken). */
export function memoryCommand(extensions: readonly MemoryExtension[] = []): Command {
	const all: Record<string, MemorySubcommand> = { ...subcommands };
	for (const extension of extensions) {
		for (const [name, run] of Object.entries(extension.subcommands)) {
			if (Object.hasOwn(all, name)) throw new KalfaError(`kalfa memory ${name} is defined twice`);
			all[name] = run;
		}
	}
	return {
		summary: 'Add, supersede, confirm, close, show or list the Memory records of Standing memory',
		usage: [...CORE_USAGE, ...extensions.flatMap((e) => e.usage.map((line) => `       ${line}`))].join('\n'),
		async run(args, io) {
			const [sub, ...rest] = args;
			const run = sub && Object.hasOwn(all, sub) ? all[sub] : undefined;
			if (!run) throw new UsageError(sub ? `unknown subcommand '${sub}'` : 'give a subcommand');
			return run(rest, io);
		},
	};
}
