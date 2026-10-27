// `kalfa meter usage`: where the usage went, from the session records of this
// machine (report.ts). It reads machine data, so it runs anywhere, with or
// without the Module on in a repository.
import type { Adapter } from '../../src/adapters/adapter.ts';
import { type Command, parseCommandArgs, UsageError } from '../../src/cli/command.ts';
import { KalfaError } from '../../src/core/errors.ts';
import { report } from './report.ts';

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
		usage: 'kalfa meter usage [--since YYYY-MM-DD | --days <n>] [--project <text>] [--top <n>] [--harness <name>]   (default: the last 7 days)',
		async run(args, io) {
			const [sub, ...rest] = args;
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
			for (const adapter of sources(adapters, io.env, values.harness)) {
				const sessions = adapter.usage!.sessions(io.env, since).filter((s) => !values.project || s.project.includes(values.project));
				io.out(`${adapter.name}, since ${values.since ?? new Date(since).toISOString().slice(0, 16).replace('T', ' ')}${values.project ? `, projects matching "${values.project}"` : ''}.\n`);
				io.out(report(sessions, top));
			}
			return 0;
		},
	};
}
