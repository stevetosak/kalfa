// The order of search hits (ADR 0003): Long-term memory first, then
// Short-term, then the archive, and by use within each tier. A tier counts
// only among the relevant hits: with OR, prefix and fuzzy matching most hits
// share one common word with the query, and a strict tier order put such weak
// Long-term hits above the Task Section that answered the query. So the hits
// that score at least a share of the best one come first, in tier order, and
// the weaker hits follow in the same order. This file is the one place that
// knows the order.
import type { SourceKind } from './sources.ts';

export const TIERS = ['long-term', 'short-term', 'archive'] as const;
export type Tier = (typeof TIERS)[number];

/** The tier of each kind of source while it is current; a closed one ranks with the archive. */
const KIND_TIER: Readonly<Record<SourceKind, Tier>> = {
	memory: 'long-term',
	deferred: 'long-term',
	doc: 'long-term',
	task: 'short-term',
	archive: 'archive',
};

/**
 * The share of the best score a hit needs to be in the relevant band. An
 * estimate (2026-11-22, measured on five queries in kalfa), to be tuned from
 * the shadow log of the searches.
 */
export const RELEVANT_SHARE = 0.25;

export interface Rankable {
	kind: SourceKind;
	/** A Memory record or a deferred item that is closed: it no longer holds. */
	closed?: boolean;
	score: number;
}

export const tierOf = (hit: Pick<Rankable, 'kind' | 'closed'>): Tier => (hit.closed ? 'archive' : KIND_TIER[hit.kind]);

/**
 * The hits in search order: the relevant band, then the rest; in each, by
 * tier, then by use day (the latest first; a hit without one after those with
 * one), then by score. `useDay` gives a hit's `YYYY-MM-DD` day of last use.
 */
/** The score a hit needs to be in the relevant band of `hits`. */
const bandFloor = (hits: readonly Rankable[]): number => RELEVANT_SHARE * hits.reduce((best, hit) => Math.max(best, hit.score), 0);

/** The hits in the relevant band, the ones that score at least a share of the best one. */
export function relevantBand<T extends Rankable>(hits: readonly T[]): T[] {
	const floor = bandFloor(hits);
	return hits.filter((hit) => hit.score >= floor);
}

export function rankHits<T extends Rankable>(hits: readonly T[], useDay: (hit: T) => string | undefined): T[] {
	const floor = bandFloor(hits);
	return hits
		.map((hit) => ({ hit, band: hit.score >= floor ? 0 : 1, tier: TIERS.indexOf(tierOf(hit)), day: useDay(hit) ?? '' }))
		.sort((a, b) => a.band - b.band || a.tier - b.tier || b.day.localeCompare(a.day) || b.hit.score - a.hit.score)
		.map(({ hit }) => hit);
}
