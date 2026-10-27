import { parseArgs, type ParseArgsConfig } from 'node:util';
import { KalfaError } from '../core/errors.ts';
import type { Io } from './io.ts';

export interface Command {
	summary: string;
	usage: string;
	/** Returns the exit code. */
	run(args: string[], io: Io): Promise<number>;
}

/** A wrong command line; the CLI exits 2 and prints the usage. */
export class UsageError extends KalfaError {
	override name = 'UsageError';
}

type Options = NonNullable<ParseArgsConfig['options']>;

/** `parseArgs` in strict mode, with its errors turned into a UsageError. */
export function parseCommandArgs<O extends Options>(args: string[], options: O, allowPositionals = false) {
	try {
		return parseArgs({ args, options, strict: true, allowPositionals });
	} catch (error) {
		throw new UsageError((error as Error).message);
	}
}
