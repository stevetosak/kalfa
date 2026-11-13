// `kalfa meter usage`: where the usage went, from the session records of this
// machine (report.ts), with the Resets of Auto mode. It reads machine data, so
// it runs anywhere, with or without the Module on in a repository.
// `kalfa meter auto [off]`: the agent turns Auto mode on for its own session,
// only when the Operator asks for an autonomous run. `kalfa meter reset-wait`
// is the detached waiter that `section close` starts (reset.ts).
import type { Adapter } from '../../src/adapters/adapter.ts';
import { type Command, parseCommandArgs, UsageError } from '../../src/cli/command.ts';
import type { Io } from '../../src/cli/io.ts';
import { KalfaError } from '../../src/core/errors.ts';
import { inHerdr, herdrCli } from '../herdr/launcher.ts';
import { report } from './report.ts';
import { readResets, resetJobSchema, runReset, sleepSync } from './reset.ts';
import { readState, stateDir, writeState } from './state.ts';

const DAY_MS = 86_400_000;

/** The harnesses to read: the one named, else the one this runs in, else every one that keeps usage. */
function sources(adapters: ReadonlyMap<string, Adapter>, env: NodeJS.ProcessEnv, flag: string | undefined): Adapter[] {
	if (flag) {
		const named = adapters.get(flag);
		if (!named?.usage) throw new KalfaError(`no Adapter with usage for harness '${flag}'`);
		return [named];
	}
	const withUsage = [...adapters.values()].filter((a) => a.usage);
	const current = withUsage.find((a) => a.detect(env));
	return current ? [current] : withUsage;
}

export function meterCommand(adapters: ReadonlyMap<string, Adapter>, now = () => Date.now()): Command {
	return {
		summary: 'meter Module: where the usage went (API-equivalent dollars), from the sessions on this machine',
		usage: 'kalfa meter usage [--since YYYY-MM-DD | --days <n>] [--project <text>] [--top <n>] [--harness <name>]   (default: the last 7 days)\n       kalfa meter auto [off]   (Auto mode for this session; only when the Operator asks for an autonomous run)',
		async run(args, io) {
			const [sub, ...rest] = args;
			if (sub === 'auto') return auto(adapters, rest, io);
			if (sub === 'reset-wait') return resetWait(rest, io);
			if (sub !== 'usage') throw new UsageError(sub ? `unknown subcommand '${sub}'` : 'give a subcommand');
			const { values } = parseCommandArgs(rest, {
				since: { type: 'string' },
				days: { type: 'string' },
				project: { type: 'string' },
				top: { type: 'string' },
				harness: { type: 'string' },
			});
			const since = values.since ? Date.parse(`${values.since}T00:00:00`) : now() - Number(values.days ?? 7) * DAY_MS;
			if (Number.isNaN(since)) throw new UsageError(`--since takes YYYY-MM-DD, not ${values.since}`);
			const top = Number(values.top ?? 15);
			if (!Number.isInteger(top) || top < 1) throw new UsageError(`--top takes a whole number, not ${values.top}`);
			const resetLog = readResets(stateDir(io.env)).filter((e) => e.at >= since && (!values.project || e.repo.includes(values.project)));
			for (const adapter of sources(adapters, io.env, values.harness)) {
				const sessions = adapter.usage!.sessions(io.env, since).filter((s) => !values.project || s.project.includes(values.project));
				io.out(`${adapter.name}, since ${values.since ?? new Date(since).toISOString().slice(0, 16).replace('T', ' ')}${values.project ? `, projects matching "${values.project}"` : ''}.\n`);
				io.out(report(sessions, top, undefined, resetLog));
			}
			return 0;
		},
	};
}

/** `kalfa meter auto [off]`: the agent's switch for its own session. */
function auto(adapters: ReadonlyMap<string, Adapter>, args: string[], io: Io): number {
	const [arg, ...extra] = args;
	if (extra.length || (arg !== undefined && arg !== 'off')) throw new UsageError('kalfa meter auto takes nothing, or off');
	const session = [...adapters.values()].find((a) => a.detect(io.env))?.currentSession?.(io.env);
	if (!session) throw new KalfaError('kalfa meter auto: the harness does not say which session this is, so Auto mode cannot be set; the Operator can type /meter auto');
	if (arg !== 'off' && !(inHerdr(io.env) && io.env.HERDR_PANE_ID)) throw new KalfaError('kalfa meter auto: Auto mode types its Reset into the Herdr pane, and this session is not in one');
	const dir = stateDir(io.env);
	const { auto: _, ...state } = readState(dir, session);
	writeState(dir, session, arg === 'off' ? state : { ...state, auto: true });
	io.out(arg === 'off' ? 'Auto mode off for this session: the meter reminds the Operator to compact again.' : 'Auto mode on for this session: past the compact point, `kalfa section close` resets it when the turn ends (/clear, then continue). `kalfa meter auto off` or /meter on ends it.');
	return 0;
}

/** The detached waiter of one Reset; its result goes to resets.jsonl. */
function resetWait(args: string[], io: Io): number {
	const job = resetJobSchema.parse(JSON.parse(args[0] ?? 'null'));
	const entry = runReset(job, { exec: herdrCli, dir: stateDir(io.env), now: () => Date.now(), sleep: sleepSync });
	io.out(JSON.stringify(entry));
	return entry.kind === 'reset' ? 0 : 1;
}
