// `kalfa memory`: the memory Module owns Long-term memory (ADR 0003), so it
// owns the whole command: the record subcommands (records.ts), search, lint
// and the Migration of the Task Records (migrate.ts). The Core keeps the Memory home, the record format and the use
// counts, which its own commands and the session start read too.
import { type Command, parseCommandArgs, UsageError } from '../../src/cli/command.ts';
import type { Io } from '../../src/cli/io.ts';
import { requireModule, requireProject } from '../../src/cli/project.ts';
import { memoryHome, sessionLayers } from '../../src/core/memory/home.ts';
import { markUsed } from '../../src/core/memory/usage.ts';
import { loadProject, type Project } from '../../src/core/project.ts';
import { loadSettings } from '../../src/core/settings.ts';
import { findingLine } from './lint.ts';
import { migrate, migrationLines, migrationPlan } from './migrate.ts';
import { lintHere, settingsOf, sourceScope } from './handlers.ts';
import { type MemorySubcommand, RECORD_USAGE, recordSubcommands } from './records.ts';
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

async function migrateCommand(args: string[], io: Io): Promise<number> {
	const { values } = parseCommandArgs(args, { 'dry-run': { type: 'boolean' } });
	const project = requireProject(io);
	const days = settingsOf({ project, settings: loadSettings(io.env) })['window-days'];
	const dryRun = values['dry-run'] === true;
	const result = dryRun ? migrationPlan(project, days) : migrate(project, memoryHome(io.env), days);
	io.out(migrationLines(result, dryRun).join('\n'));
	return result.failure ? 1 : 0;
}

const subcommands: Record<string, MemorySubcommand> = { ...recordSubcommands, search, lint: lintCommand, migrate: migrateCommand };

/** Subcommands that are gone, each with its reason: an older instruction or record may still name one. */
const RETIRED: Readonly<Record<string, string>> = {
	inbox: 'the inbox is gone (ADR 0003): the Cleanup at Task close writes the findings as records, and no Memory candidate waits',
};

const USAGE = [
	...RECORD_USAGE,
	'kalfa memory search <words> [--limit <n>]',
	'kalfa memory lint',
	'kalfa memory migrate [--dry-run]   (once per repository: the closed Task Records from before the Cleanup are marked reconciled, then those outside the Short-term window move to the archive)',
];

/** `kalfa memory`: it runs only where the machine settings or the project file turn the memory Module on. */
export function memoryCommand(): Command {
	return {
		summary: 'Add, supersede, confirm, close, show, list and search the Memory records (the memory Module)',
		usage: USAGE.join('\n       '),
		async run(args, io) {
			const [sub, ...rest] = args;
			if (sub && Object.hasOwn(RETIRED, sub)) throw new UsageError(RETIRED[sub]!);
			const run = sub && Object.hasOwn(subcommands, sub) ? subcommands[sub] : undefined;
			if (!run) throw new UsageError(sub ? `unknown subcommand '${sub}'` : 'give a subcommand');
			requireModule(loadProject(io.cwd), 'memory', io.env);
			return run(rest, io);
		},
	};
}
