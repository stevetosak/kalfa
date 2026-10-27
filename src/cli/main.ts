import pkg from '../../package.json' with { type: 'json' };
import { KalfaError } from '../core/errors.ts';
import { type Command, UsageError } from './command.ts';
import { adapters } from '../adapters/index.ts';
import { modules } from '../modules/index.ts';
import { doctor } from './commands/doctor.ts';
import { hookCommand } from './commands/hook.ts';
import { planCommand } from './commands/plan.ts';
import { sectionCommand, taskCommand } from './commands/task.ts';
import type { Io } from './io.ts';

const commands: Record<string, Command> = {
	doctor,
	hook: hookCommand(adapters, modules),
	task: taskCommand(adapters, modules),
	section: sectionCommand(adapters, modules),
	plan: planCommand,
};

export const version = pkg.version;

function usage(): string {
	const width = Math.max(...Object.keys(commands).map((name) => name.length));
	const lines = Object.entries(commands).map(([name, command]) => `  ${name.padEnd(width)}  ${command.summary}`);
	return [`kalfa ${version}`, '', 'Usage: kalfa <command> [options]', '', 'Commands:', ...lines, '', 'kalfa <command> --help shows the usage of one command.'].join('\n');
}

/** Runs one kalfa command line and returns the exit code. */
export async function main(argv: string[], io: Io): Promise<number> {
	const [name, ...args] = argv;
	if (name === undefined) {
		io.err(usage());
		return 2;
	}
	if (name === 'help' || name === '--help' || name === '-h') {
		io.out(usage());
		return 0;
	}
	if (name === 'version' || name === '--version' || name === '-v') {
		io.out(version);
		return 0;
	}
	const command = Object.hasOwn(commands, name) ? commands[name] : undefined;
	if (!command) {
		io.err(`kalfa: unknown command '${name}'\n\n${usage()}`);
		return 2;
	}
	if (args.includes('--help') || args.includes('-h')) {
		io.out(`${command.summary}\n\nUsage: ${command.usage}`);
		return 0;
	}
	try {
		return await command.run(args, io);
	} catch (error) {
		if (error instanceof UsageError) {
			io.err(`kalfa ${name}: ${error.message}\n\nUsage: ${command.usage}`);
			return 2;
		}
		if (error instanceof KalfaError) {
			io.err(`kalfa ${name}: ${error.message}`);
			return 1;
		}
		throw error;
	}
}
