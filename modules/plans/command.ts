// `kalfa defer`: the plans Module's deferred list (see deferred.ts). The
// `defer` skill adds an item at the Operator's word; the Operator takes an
// item on (it becomes a Plan or a Task) or drops it. Each change is one
// commit in the Memory home, so the history says when and why.
import { layerFor, layerName, layersFor } from '../../src/cli/commands/memory.ts';
import { type Command, parseCommandArgs, UsageError } from '../../src/cli/command.ts';
import type { Io } from '../../src/cli/io.ts';
import { requireModule } from '../../src/cli/project.ts';
import { KalfaError } from '../../src/core/errors.ts';
import { type Layer, memoryHome } from '../../src/core/memory/home.ts';
import { slugOf } from '../../src/core/memory/record.ts';
import { loadProject } from '../../src/core/project.ts';
import { checkItemId, type DeferredItem, type DeferredStatus, itemLine, renderItem, scanDeferred, writeItem } from './deferred.ts';

const today = () => new Date().toLocaleDateString('sv-SE');
const layerOption = { layer: { type: 'string' } } as const;

function moduleHere(io: Io): void {
	requireModule(loadProject(io.cwd), 'plans', io.env);
}

function uniqueId(items: readonly DeferredItem[], wanted: string): string {
	const taken = new Set(items.map((i) => i.id));
	if (!taken.has(wanted)) return wanted;
	for (let n = 2; ; n++) if (!taken.has(`${wanted}-${n}`)) return `${wanted}-${n}`;
}

function findItem(io: Io, id: string, layer: string | undefined): { layer: Layer; item: DeferredItem } {
	const found = layersFor(io, layerName(layer)).flatMap((l) => scanDeferred(l).items.flatMap((item) => (item.id === id ? [{ layer: l, item }] : [])));
	if (!found.length) throw new KalfaError(`no deferred item '${id}'${layer ? ` in the ${layer} layer` : ''} (kalfa defer list --all)`);
	if (found.length > 1) throw new KalfaError(`'${id}' is in more than one layer; name one with --layer personal|project`);
	return found[0]!;
}

/** Takes an open item off the list, with the reason in its commit. */
async function close(args: string[], io: Io, status: Exclude<DeferredStatus, 'open'>, reasonNeeded: boolean): Promise<number> {
	moduleHere(io);
	const { values, positionals } = parseCommandArgs(args, layerOption, true);
	const [id, ...words] = positionals;
	const reason = words.join(' ').replace(/\s+/g, ' ').trim();
	if (!id) throw new UsageError('give the id of the deferred item');
	if (reasonNeeded && !reason) throw new UsageError(`give the reason: kalfa defer drop ${id} "<why it will not be done>"`);
	const { layer, item } = findItem(io, id, values.layer);
	if (item.header.status !== 'open') throw new KalfaError(`'${id}' is already ${item.header.status}`);
	const verb = status === 'taken' ? 'take' : 'drop';
	writeItem(memoryHome(io.env), layer, { ...item, header: { ...item.header, status, closed: today() } }, `defer ${verb} ${id} (${layer.label})${reason ? `: ${reason}` : ''}`);
	io.out(`${id} is ${status} (${layer.label}); it leaves the deferred list`);
	return 0;
}

const subcommands: Record<string, (args: string[], io: Io) => Promise<number>> = {
	async add(args, io) {
		moduleHere(io);
		const { values } = parseCommandArgs(args, { ...layerOption, summary: { type: 'string' }, when: { type: 'string' }, id: { type: 'string' } });
		const name = layerName(values.layer);
		if (!name) throw new UsageError('give --layer project, or --layer personal for an item about no one repository');
		if (!values.summary?.trim()) throw new UsageError('give --summary "<what is deferred>"');
		if (values.id !== undefined) checkItemId(values.id);
		const layer = layerFor(io, name);
		const { items } = scanDeferred(layer);
		if (values.id !== undefined && items.some((i) => i.id === values.id)) throw new KalfaError(`'${values.id}' already exists in the ${layer.label} layer`);
		const item: DeferredItem = {
			id: values.id ?? uniqueId(items, slugOf(values.summary)),
			header: { schema: 1, status: 'open', summary: values.summary.trim(), created: today(), ...(values.when?.trim() ? { condition: values.when.trim() } : {}) },
			body: (await io.stdin()).trim(),
		};
		const path = writeItem(memoryHome(io.env), layer, item, `defer add ${item.id} (${layer.label})`);
		io.out(`Deferred ${item.id} in the ${layer.label} layer: ${path}`);
		return 0;
	},

	async list(args, io) {
		moduleHere(io);
		const { values } = parseCommandArgs(args, { ...layerOption, all: { type: 'boolean' } });
		let shown = 0;
		for (const layer of layersFor(io, layerName(values.layer))) {
			const { items, problems } = scanDeferred(layer);
			for (const problem of problems) io.err(`kalfa defer: left out: ${problem}`);
			const listed = values.all ? items : items.filter((i) => i.header.status === 'open');
			if (!listed.length) continue;
			io.out(`${layer.label}:`);
			for (const item of listed) io.out(values.all && item.header.status !== 'open' ? `${itemLine(item)}  [${item.header.status} ${item.header.closed ?? ''}]`.trimEnd() : itemLine(item));
			shown += listed.length;
		}
		if (!shown) io.out(values.all ? 'no deferred items' : 'no open deferred items (--all shows the taken and dropped ones)');
		return 0;
	},

	async show(args, io) {
		moduleHere(io);
		const { values, positionals } = parseCommandArgs(args, layerOption, true);
		const [id, ...extra] = positionals;
		if (!id || extra.length) throw new UsageError('give the id of one deferred item');
		const { layer, item } = findItem(io, id, values.layer);
		io.out(`${id} (${layer.label})\n\n${renderItem(item).trimEnd()}`);
		return 0;
	},

	take: (args, io) => close(args, io, 'taken', false),
	drop: (args, io) => close(args, io, 'dropped', true),
};

export function deferCommand(): Command {
	return {
		summary: 'plans Module: the deferred list, work the Operator has not taken on (private, in the Memory home)',
		usage: [
			'kalfa defer add --layer project|personal --summary "<what>" [--when "<what brings it back>"] [--id <id>]   (body on stdin: why, and the source)',
			'       kalfa defer list [--layer …] [--all]',
			'       kalfa defer show <id> [--layer …]',
			'       kalfa defer take <id> ["<the Plan or Task it became>"] [--layer …]',
			'       kalfa defer drop <id> "<why it will not be done>" [--layer …]',
		].join('\n'),
		async run(args, io) {
			const [sub, ...rest] = args;
			const run = sub ? subcommands[sub] : undefined;
			if (!run) throw new UsageError(sub ? `unknown subcommand '${sub}'` : 'give a subcommand');
			return run(rest, io);
		},
	};
}
