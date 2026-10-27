// `kalfa herdr continue`: starts the successor of this session on an open Task
// (see successor.ts). The `successor` skill asks the Operator before it runs
// this. Exit 3 means a usage limit is near and nothing started.
import type { Adapter } from '../../src/adapters/adapter.ts';
import { type Command, parseCommandArgs, UsageError } from '../../src/cli/command.ts';
import { openRecord, taskId } from '../../src/cli/commands/task.ts';
import { requireModule, requireProject } from '../../src/cli/project.ts';
import { KalfaError } from '../../src/core/errors.ts';
import { checkLimits, type LimitVerdict, limitsPath } from '../../src/core/usage-limits.ts';
import { continueTask, defaultLauncher, type Launcher } from './successor.ts';

export const LIMIT_EXIT = 3;

export interface HerdrCommandDeps {
	launcher?: (adapter: Adapter, env: NodeJS.ProcessEnv) => Launcher;
	limits?: (env: NodeJS.ProcessEnv) => LimitVerdict;
}

/** The harness named by --harness, else the one this command runs in. */
function harness(adapters: ReadonlyMap<string, Adapter>, env: NodeJS.ProcessEnv, flag: string | undefined): Adapter {
	if (flag) {
		const named = adapters.get(flag);
		if (!named) throw new KalfaError(`no Adapter for harness '${flag}' (known: ${[...adapters.keys()].join(', ')})`);
		return named;
	}
	const found = [...adapters.values()].find((a) => a.detect(env));
	if (!found) throw new KalfaError('kalfa cannot tell which harness to start; name it with --harness <name>');
	return found;
}

export function herdrCommand(adapters: ReadonlyMap<string, Adapter>, deps: HerdrCommandDeps = {}): Command {
	return {
		summary: 'herdr Module: start the next session on an open Task (a new Herdr tab, else in the background)',
		usage: 'kalfa herdr continue [--task <id>] [--harness <name>] [--name <session name>] [--model <model>] [--force]\n       (exit 3: a usage limit is near and nothing started; --force starts anyway)',
		async run(args, io) {
			const [sub, ...rest] = args;
			if (sub !== 'continue') throw new UsageError(sub ? `unknown subcommand '${sub}'` : 'give a subcommand');
			const { values } = parseCommandArgs(rest, {
				task: { type: 'string' },
				harness: { type: 'string' },
				name: { type: 'string' },
				model: { type: 'string' },
				force: { type: 'boolean' },
			});
			const project = requireProject(io);
			requireModule(project, 'herdr');
			const record = openRecord(project, taskId(project, values.task));
			const adapter = harness(adapters, io.env, values.harness);
			const result = continueTask({
				task: record.id,
				cwd: project.root,
				name: values.name,
				model: values.model,
				force: values.force,
				launcher: (deps.launcher ?? defaultLauncher)(adapter, io.env),
				limits: () => (deps.limits ?? ((env) => checkLimits(limitsPath(env))))(io.env),
			});
			if (!result.launched) {
				io.err(`kalfa herdr: ${result.reason}. Nothing started; the Task waits in its record.`);
				return LIMIT_EXIT;
			}
			io.out(result.output);
			io.out(`Usage: ${result.note}.`);
			return 0;
		},
	};
}
