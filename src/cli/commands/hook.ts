// `kalfa hook <harness> <event>`: the Dispatcher's entry point. A harness hook
// (through the `kalfa-hook` shim) pipes its payload in; the Adapter translates
// both ways. It never exits 2 on its own error, because some harnesses read 2
// as "block".
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Adapter } from '../../adapters/adapter.ts';
import { activeModules, dispatch } from '../../core/dispatcher.ts';
import { KalfaError } from '../../core/errors.ts';
import { isCoreEventName } from '../../core/events.ts';
import { EVENT_TABLE, isTableFresh, machineEventTablePath, writeEventTable, writeMachineEventTable } from '../../core/fast-path.ts';
import type { HandlerContext, ModuleDefinition } from '../../core/modules.ts';
import { PRIVATE_DIR } from '../../core/private-dir.ts';
import { loadProject, PROJECT_FILE, type Project, repoRootOf } from '../../core/project.ts';
import { DEFAULT_SETTINGS, loadSettings, type Settings, settingsPath } from '../../core/settings.ts';
import type { Command } from '../command.ts';
import type { Io } from '../io.ts';

const USAGE = 'kalfa hook <harness> <event>   (the hook payload is read from stdin)';

/** Runs `load`; a KalfaError becomes a notice and the fallback is used. */
function orNotice<T>(load: () => T, fallback: T, notices: string[]): T {
	try {
		return load();
	} catch (error) {
		if (!(error instanceof KalfaError)) throw error;
		notices.push(`kalfa: ${error.message}`);
		return fallback;
	}
}

/**
 * Rewrites the event tables the shim reads: at session start, and whenever a
 * table is older than a file it is made from (else the shim starts Node on
 * every event until the next session).
 */
function refreshEventTables(force: boolean, context: HandlerContext, registry: ReadonlyMap<string, ModuleDefinition>, notices: string[]): void {
	const config = settingsPath(context.env);
	// Without machine settings the shim needs no machine table (it exits at once).
	if (existsSync(config) && (force || !isTableFresh(machineEventTablePath(context.env), [config]))) {
		const machineOnly = { project: undefined, settings: context.settings };
		orNotice(() => writeMachineEventTable(context.env, activeModules(registry, machineOnly).modules, machineOnly), '', notices);
	}
	const project = context.project;
	if (!project?.file) return;
	const sources = [join(project.root, PROJECT_FILE), config];
	if (force || !isTableFresh(join(project.root, PRIVATE_DIR, EVENT_TABLE), sources)) {
		orNotice(() => writeEventTable(project.root, activeModules(registry, context).modules, context), '', notices);
	}
}

async function runHook(args: string[], io: Io, adapters: ReadonlyMap<string, Adapter>, registry: ReadonlyMap<string, ModuleDefinition>): Promise<number> {
	const [harness, name, ...rest] = args;
	if (!harness || !name || rest.length) throw new KalfaError(`usage: ${USAGE}`);
	const adapter = adapters.get(harness);
	if (!adapter) throw new KalfaError(`no Adapter for harness '${harness}' (known: ${[...adapters.keys()].join(', ') || 'none'})`);
	if (!isCoreEventName(name)) throw new KalfaError(`'${name}' is not a Core event`);

	let payload: unknown;
	try {
		payload = JSON.parse(await io.stdin());
	} catch (error) {
		throw new KalfaError(`the hook payload is not JSON: ${(error as Error).message}`);
	}
	const event = adapter.toEvent(name, payload);
	if (!event) return 0;

	const notices: string[] = [];
	const root = repoRootOf(event.cwd);
	const project: Project | undefined = orNotice(() => loadProject(event.cwd), root ? { root, file: undefined } : undefined, notices);
	const settings: Settings = orNotice(() => loadSettings(io.env), DEFAULT_SETTINGS, notices);
	const context: HandlerContext = { project, settings, env: io.env, capabilities: adapter.capabilities, usage: adapter.usage };

	const result = await dispatch(event, registry, context);
	result.notice.unshift(...notices);
	refreshEventTables(event.name === 'session.start', context, registry, result.notice);

	const out = adapter.render(event, result);
	if (out.stdout) io.out(out.stdout);
	if (out.stderr) io.err(out.stderr);
	return out.exitCode;
}

export function hookCommand(adapters: ReadonlyMap<string, Adapter>, registry: ReadonlyMap<string, ModuleDefinition>): Command {
	return {
		summary: 'Run the handlers for one Core event (called by a harness hook)',
		usage: USAGE,
		async run(args, io) {
			try {
				return await runHook(args, io, adapters, registry);
			} catch (error) {
				io.err(`kalfa hook: ${(error as Error).message}`);
				return 1;
			}
		},
	};
}
