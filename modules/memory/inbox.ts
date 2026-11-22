// The inbox: Memory candidates that wait for the Operator's answer (ADR 0002).
// One file per candidate in `inbox/` of the Memory home, outside every layer,
// so a candidate never loads before the Operator accepts it. Task close no
// longer adds to it: the Cleanup writes the findings (ADR 0003), and the inbox
// retires once the candidates that wait in it are decided.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { KalfaError } from '../../src/core/errors.ts';
import { parseVersioned, type VersionedFormat } from '../../src/core/versioned-file.ts';

const headerSchema = z.strictObject({
	schema: z.literal(1),
	/** The project key of the Task that found it. */
	project: z.string().min(1),
	task: z.string().min(1),
	created: z.iso.date(),
});

type CandidateHeader = z.infer<typeof headerSchema>;

const headerFormat: VersionedFormat<CandidateHeader> = { name: 'Memory candidate', current: 1, schema: headerSchema };

export interface Candidate extends CandidateHeader {
	id: string;
	path: string;
	text: string;
}

export function inboxDir(home: string): string {
	return join(home, 'inbox');
}

export function readInbox(home: string): { candidates: Candidate[]; problems: string[] } {
	const dir = inboxDir(home);
	const out = { candidates: [] as Candidate[], problems: [] as string[] };
	if (!existsSync(dir)) return out;
	for (const name of readdirSync(dir).filter((n) => n.endsWith('.md')).sort()) {
		const path = join(dir, name);
		const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(readFileSync(path, 'utf8').replace(/\r\n/g, '\n'));
		try {
			if (!match) throw new KalfaError(`${path}: a Memory candidate starts with a --- YAML header ---`);
			out.candidates.push({ id: name.slice(0, -3), path, ...parseVersioned(match[1]!, path, headerFormat), text: match[2]!.trim() });
		} catch (error) {
			if (!(error instanceof KalfaError)) throw error;
			out.problems.push(error.message);
		}
	}
	return out;
}

export function findCandidate(home: string, id: string): Candidate {
	const candidate = readInbox(home).candidates.find((c) => c.id === id);
	if (!candidate) throw new KalfaError(`no Memory candidate '${id}' in the inbox (kalfa memory inbox)`);
	return candidate;
}

