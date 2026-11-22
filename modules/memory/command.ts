// `kalfa memory`: the memory Module owns Long-term memory (ADR 0003), so it
// owns the whole command: the record subcommands (records.ts), search, lint,
// inbox and the Migration of the Task Records (migrate.ts). The Core keeps the Memory home, the record format and the use
// counts, which its own commands and the session start read too.
import { type Command, parseCommandArgs, UsageError } from '../../src/cli/command.ts';
import type { Io } from '../../src/cli/io.ts';
import { layerName } from '../../src/cli/layers.ts';
import { requireModule, requireProject } from '../../src/cli/project.ts';
import { commitHome, memoryHome, personalLayer, projectLayerOfKey, sessionLayers } from '../../src/core/memory/home.ts';
import { markUsed } from '../../src/core/memory/usage.ts';
import { loadProject, type Project } from '../../src/core/project.ts';
import { loadSettings } from '../../src/core/settings.ts';
import { findCandidate, readInbox } from './inbox.ts';
import { findingLine } from './lint.ts';
import { migrate, migrationLines, migrationPlan } from './migrate.ts';
import { lintHere, settingsOf, sourceScope } from './handlers.ts';
import { addRecord, type MemorySubcommand, RECORD_USAGE, recordSubcommands, recordType } from './records.ts';
import { type Hit, openIndex } from './search.ts';

const DEFAULT_LIMIT = 10;


/**
 * Marks the Memory records among the hits as used, per layer (ADR 0002,
 * amendment 2026-11-08). Only this command does it: the session recall shows
 * hits nobody asked for, so they are not a use.
 */
function markHitsUsed(hits: readonly Hit[], project: Project | undefined, env: NodeJS.ProcessEnv): void {
	for (const layer of sessionLayers(memoryHome(env), project)) {
		const ids = hits.flatMap((hit) => (hit.record?.layer === layer.label ? [hit.record.id] : []));
		markUsed(layer, ids, env);
	}
}

async function search(args: string[], io: Io): Promise<number> {
	const { values, positionals } = parseCommandArgs(args, { limit: { type: 'string' } }, true);
	const query = positionals.join(' ').trim();
	if (!query) throw new UsageError('give the words to search for');
	const limit = values.limit === undefined ? DEFAULT_LIMIT : Number(values.limit);
	if (!Number.isInteger(limit) || limit < 1) throw new UsageError('--limit is a whole number from 1');
	const project = loadProject(io.cwd);
	const settings = settingsOf({ project, settings: loadSettings(io.env) });
	const index = openIndex(sourceScope(project, settings, io.env));
	for (const problem of index.problems) io.err(`kalfa memory search: left out: ${problem}`);
	const hits = index.search(query, limit);
	markHitsUsed(hits, project, io.env);
	if (!hits.length) io.out('no hits');
	for (const hit of hits) io.out(`[${hit.kind}] ${hit.title}\n    ${hit.ref}${hit.snippet ? `\n    ${hit.snippet}` : ''}`);
	return 0;
}

async function lintCommand(args: string[], io: Io): Promise<number> {
	parseCommandArgs(args, {});
	const project = loadProject(io.cwd);
	const coreSettings = loadSettings(io.env);
	const findings = lintHere(project, coreSettings, settingsOf({ project, settings: coreSettings }), io.env);
	io.out(findings.length ? findings.map(findingLine).join('\n') : 'no findings');
	// The lint reports; it never fails a run, and it never hides a record.
	return 0;
}

const inboxSubcommands: Record<string, MemorySubcommand> = {
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
	return run(rest, io);
}

async function migrateCommand(args: string[], io: Io): Promise<number> {
	const { values } = parseCommandArgs(args, { 'dry-run': { type: 'boolean' } });
	const project = requireProject(io);
	const days = settingsOf({ project, settings: loadSettings(io.env) })['window-days'];
	const dryRun = values['dry-run'] === true;
	const result = dryRun ? migrationPlan(project, days) : migrate(project, memoryHome(io.env), days);
	io.out(migrationLines(result, dryRun).join('\n'));
	return result.failure ? 1 : 0;
}

const subcommands: Record<string, MemorySubcommand> = { ...recordSubcommands, search, lint: lintCommand, inbox, migrate: migrateCommand };

const USAGE = [
	...RECORD_USAGE,
	'kalfa memory search <words> [--limit <n>]',
	'kalfa memory lint',
	'kalfa memory inbox [list]',
	'kalfa memory inbox accept <id> --type fact|decision|open|hub --layer personal|project --summary "<one line>" [--id <id>] [--source <link>]   (body on stdin, optional)',
	'kalfa memory inbox reject <id> "<reason>"',
	'kalfa memory migrate [--dry-run]   (once per repository: the closed Task Records from before the Cleanup are marked reconciled, then those outside the Short-term window move to the archive)',
];

/** `kalfa memory`: it runs only where the machine settings or the project file turn the memory Module on. */
export function memoryCommand(): Command {
	return {
		summary: 'Add, supersede, confirm, close, show, list and search the Memory records (the memory Module)',
		usage: USAGE.join('\n       '),
		async run(args, io) {
			const [sub, ...rest] = args;
			const run = sub && Object.hasOwn(subcommands, sub) ? subcommands[sub] : undefined;
			if (!run) throw new UsageError(sub ? `unknown subcommand '${sub}'` : 'give a subcommand');
			requireModule(loadProject(io.cwd), 'memory', io.env);
			return run(rest, io);
		},
	};
}
