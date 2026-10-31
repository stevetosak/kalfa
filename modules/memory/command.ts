// The memory Module's subcommands of `kalfa memory`: search, lint and inbox.
// The Core keeps add, supersede, confirm, show and list.
import { addRecord, layerName, type MemoryExtension, recordType } from '../../src/cli/commands/memory.ts';
import { parseCommandArgs, UsageError } from '../../src/cli/command.ts';
import type { Io } from '../../src/cli/io.ts';
import { requireModule } from '../../src/cli/project.ts';
import { commitHome, memoryHome, personalLayer, projectLayerOfKey } from '../../src/core/memory/home.ts';
import { loadProject, type Project } from '../../src/core/project.ts';
import { loadSettings } from '../../src/core/settings.ts';
import { findCandidate, readInbox } from './inbox.ts';
import { findingLine } from './lint.ts';
import { lintHere, settingsOf, sourceScope } from './handlers.ts';
import { openIndex } from './search.ts';

const DEFAULT_LIMIT = 10;

/** The project here, once the Module is on here. */
function moduleHere(io: Io): Project | undefined {
	const project = loadProject(io.cwd);
	requireModule(project, 'memory', io.env);
	return project;
}

async function search(args: string[], io: Io): Promise<number> {
	const { values, positionals } = parseCommandArgs(args, { limit: { type: 'string' } }, true);
	const query = positionals.join(' ').trim();
	if (!query) throw new UsageError('give the words to search for');
	const limit = values.limit === undefined ? DEFAULT_LIMIT : Number(values.limit);
	if (!Number.isInteger(limit) || limit < 1) throw new UsageError('--limit is a whole number from 1');
	const project = moduleHere(io);
	const settings = settingsOf({ project, settings: loadSettings(io.env) });
	const index = openIndex(sourceScope(project, settings, io.env));
	for (const problem of index.problems) io.err(`kalfa memory search: left out: ${problem}`);
	const hits = index.search(query, limit);
	if (!hits.length) io.out('no hits');
	for (const hit of hits) io.out(`[${hit.kind}] ${hit.title}\n    ${hit.ref}${hit.snippet ? `\n    ${hit.snippet}` : ''}`);
	return 0;
}

async function lintCommand(args: string[], io: Io): Promise<number> {
	parseCommandArgs(args, {});
	const project = moduleHere(io);
	const coreSettings = loadSettings(io.env);
	const findings = lintHere(project, coreSettings, settingsOf({ project, settings: coreSettings }), io.env);
	io.out(findings.length ? findings.map(findingLine).join('\n') : 'no findings');
	// The lint reports; it never fails a run, and it never hides a record.
	return 0;
}

const inboxSubcommands: Record<string, (args: string[], io: Io) => Promise<number>> = {
	async list(args, io) {
		parseCommandArgs(args, {});
		const { candidates, problems } = readInbox(memoryHome(io.env));
		for (const problem of problems) io.err(`kalfa memory inbox: ${problem}`);
		if (!candidates.length) io.out('the inbox is empty');
		for (const c of candidates) io.out(`${c.id}  (${c.project}, Task ${c.task}, ${c.created})\n    ${c.text.replace(/\n/g, '\n    ')}`);
		return 0;
	},

	async accept(args, io) {
		const { values, positionals } = parseCommandArgs(
			args,
			{ type: { type: 'string' }, layer: { type: 'string' }, summary: { type: 'string' }, id: { type: 'string' }, source: { type: 'string' } },
			true,
		);
		const [id, ...extra] = positionals;
		if (!id || extra.length) throw new UsageError('give one candidate id');
		const type = recordType(values.type);
		const name = layerName(values.layer);
		if (!name) throw new UsageError('give --layer personal or --layer project');
		const home = memoryHome(io.env);
		const candidate = findCandidate(home, id);
		// The project layer is the one of the Task that found it, wherever this runs.
		const layer = name === 'personal' ? personalLayer(home) : projectLayerOfKey(home, candidate.project);
		const record = addRecord(
			io,
			layer,
			{ type, summary: values.summary, id: values.id, source: values.source ?? `Task ${candidate.task} (${candidate.project})`, body: await io.stdin() },
			{ remove: [candidate.path] },
		);
		io.out(`Accepted ${id} as ${type} ${record.id} in the ${layer.label} layer: ${record.path}`);
		return 0;
	},

	async reject(args, io) {
		const { positionals } = parseCommandArgs(args, {}, true);
		const [id, ...reasonWords] = positionals;
		const reason = reasonWords.join(' ').trim();
		if (!id || !reason) throw new UsageError('give the id and the reason: kalfa memory inbox reject <id> "<reason>"');
		const home = memoryHome(io.env);
		const candidate = findCandidate(home, id);
		commitHome(home, { remove: [candidate.path] }, `reject candidate ${id}: ${reason.replace(/\s+/g, ' ')}`);
		io.out(`Rejected ${id}`);
		return 0;
	},
};

async function inbox(args: string[], io: Io): Promise<number> {
	const [sub = 'list', ...rest] = args;
	const run = Object.hasOwn(inboxSubcommands, sub) ? inboxSubcommands[sub] : undefined;
	if (!run) throw new UsageError(`unknown inbox subcommand '${sub}'`);
	moduleHere(io);
	return run(rest, io);
}

export const memoryExtension: MemoryExtension = {
	subcommands: { search, lint: lintCommand, inbox },
	usage: [
		'kalfa memory search <words> [--limit <n>]   (the memory Module)',
		'kalfa memory lint',
		'kalfa memory inbox [list]',
		'kalfa memory inbox accept <id> --type rule|fact|decision|open --layer personal|project --summary "<one line>" [--id <id>] [--source <link>]   (body on stdin, optional)',
		'kalfa memory inbox reject <id> "<reason>"',
	],
};
