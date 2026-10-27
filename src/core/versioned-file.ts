// Every file kalfa owns carries a schema number, so a newer or older file is
// named as such instead of failing on a field it does not know.
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { z } from 'zod';
import { KalfaError } from './errors.ts';

export interface VersionedFormat<T> {
	/** How messages name the file, e.g. `kalfa.yaml`. */
	name: string;
	current: number;
	schema: z.ZodType<T>;
}

export function parseVersioned<T>(text: string, path: string, format: VersionedFormat<T>): T {
	let data: unknown;
	try {
		data = parse(text);
	} catch (error) {
		throw new KalfaError(`${path}: not valid YAML: ${(error as Error).message}`);
	}
	if (typeof data !== 'object' || data === null || Array.isArray(data)) {
		throw new KalfaError(`${path}: ${format.name} must be a mapping`);
	}
	const version = (data as Record<string, unknown>).schema;
	if (!Number.isInteger(version)) {
		throw new KalfaError(`${path}: ${format.name} needs \`schema: ${format.current}\``);
	}
	if ((version as number) > format.current) {
		throw new KalfaError(`${path}: ${format.name} schema ${version} is newer than this kalfa reads (${format.current}); upgrade kalfa`);
	}
	if ((version as number) < format.current) {
		throw new KalfaError(`${path}: ${format.name} schema ${version} is older than ${format.current}; run \`kalfa migrate\``);
	}
	const result = format.schema.safeParse(data);
	if (!result.success) {
		throw new KalfaError(`${path}: ${format.name} is not valid:\n${z.prettifyError(result.error)}`);
	}
	return result.data;
}

/** Reads and checks a versioned file; `undefined` when it does not exist. */
export function readVersioned<T>(path: string, format: VersionedFormat<T>): T | undefined {
	let text: string;
	try {
		text = readFileSync(path, 'utf8');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
		throw error;
	}
	return parseVersioned(text, path, format);
}
