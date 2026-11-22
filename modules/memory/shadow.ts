// The shadow log (ADR 0003): each prompt's search hits, written and never
// injected, so that recall on every prompt is decided from data. Part 6 of
// the memory revision compares the log with what the agent searched for and
// read. One JSON line per prompt, one file per day, in the cache folder. The
// prompt's text stays in the transcript: a line holds its hash and word count,
// and joins the transcript by session and time. A line is one append, so
// parallel sessions do not mix or lose lines.
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { machineCacheDir } from '../../src/core/machine-paths.ts';
import { RELEVANT_SHARE, type Tier, tierOf } from './ranking.ts';
import type { Hit } from './search.ts';
import type { SourceKind } from './sources.ts';

/** The hits a line keeps: more than recall injects, so a threshold can be tuned below the band. */
export const SHADOW_HITS = 10;
const PROMPT_HASH_CHARS = 16;

export interface ShadowHit {
	kind: SourceKind;
	tier: Tier;
	/** Where to read it, as recall shows it. */
	ref: string;
	/** A Memory record: `<layer label>/<id>`. */
	record?: string;
	score: number;
	/** The score's share of the best score among all the prompt's hits. */
	share: number;
	/** In the relevant band, the hits recall injects. */
	band: boolean;
	/** The session already holds it: the Task's own record or a Root Hub. */
	held: boolean;
}

export interface ShadowEntry {
	at: string;
	session?: string;
	/** The project key; none outside a repository. */
	project?: string;
	/** The branch's open Task. */
	task?: string;
	/** The session's first prompt, the one recall answers. */
	first: boolean;
	prompt: { sha256: string; words: number };
	/** Every match of the prompt's own words, before the cut to `hits`. */
	matches: number;
	hits: ShadowHit[];
	/** The hits recall injected for this prompt, by `hitKey`. */
	injected: string[];
}

/** A hit's identity in the log: the record for a Memory record, else where to read it. */
export const hitKey = (hit: Hit): string => (hit.record ? `${hit.record.layer}/${hit.record.id}` : hit.ref);

const round = (value: number, places: number) => Number(value.toFixed(places));

export interface ShadowInput {
	at: Date;
	session?: string;
	project?: string;
	task?: string;
	first: boolean;
	prompt: string;
	words: number;
	/** The prompt's hits, all of them, in search order. */
	hits: readonly Hit[];
	held: (hit: Hit) => boolean;
	injected: readonly Hit[];
}

export function shadowEntry(input: ShadowInput): ShadowEntry {
	const best = Math.max(0, ...input.hits.map((hit) => hit.score));
	return {
		at: input.at.toISOString(),
		...(input.session && { session: input.session }),
		...(input.project && { project: input.project }),
		...(input.task && { task: input.task }),
		first: input.first,
		prompt: { sha256: createHash('sha256').update(input.prompt).digest('hex').slice(0, PROMPT_HASH_CHARS), words: input.words },
		matches: input.hits.length,
		hits: input.hits.slice(0, SHADOW_HITS).map((hit) => {
			const share = best ? hit.score / best : 0;
			return {
				kind: hit.kind,
				tier: tierOf(hit),
				ref: hit.ref,
				...(hit.record && { record: hitKey(hit) }),
				score: round(hit.score, 2),
				share: round(share, 3),
				band: share >= RELEVANT_SHARE,
				held: input.held(hit),
			};
		}),
		injected: input.injected.map(hitKey),
	};
}

export const shadowDir = (env: NodeJS.ProcessEnv) => join(machineCacheDir(env), 'memory-shadow');

/** The day's file, by the local date of `at`. */
export const shadowLogPath = (env: NodeJS.ProcessEnv, at: Date) => join(shadowDir(env), `${at.toLocaleDateString('sv-SE')}.jsonl`);

/** Appends the entry as one line, in one write. */
export function appendShadow(env: NodeJS.ProcessEnv, at: Date, entry: ShadowEntry): void {
	mkdirSync(shadowDir(env), { recursive: true });
	appendFileSync(shadowLogPath(env, at), `${JSON.stringify(entry)}\n`);
}
