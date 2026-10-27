// API-equivalent prices, so that usage can be compared across sessions,
// models and phases of work. A subscription does not bill in dollars, but its
// limits follow what the same requests cost on the API, so the shares hold.
// Dollars per million tokens, from the claude-api skill (cached 2026-09-25).
// A cache write costs 1.25 times the input price with the five-minute
// lifetime and 2 times with the one-hour lifetime.
import type { CacheTtl, TokenUsage } from '../../src/core/usage.ts';

export interface Prices {
	input: number;
	output: number;
	read: number;
}

/** First match wins; a model id matches as a substring, so dated ids work too. */
const TABLE: [RegExp, Prices][] = [
	[/(fable|mythos)-5-1/, { input: 10, output: 50, read: 0.25 }],
	[/fable|mythos/, { input: 10, output: 50, read: 1 }],
	[/opus-5-5/, { input: 4, output: 20, read: 0.2 }],
	[/opus/, { input: 5, output: 25, read: 0.5 }],
	[/sonnet-4/, { input: 3, output: 15, read: 0.3 }],
	[/sonnet/, { input: 2, output: 10, read: 0.2 }],
	[/haiku/, { input: 1, output: 5, read: 0.1 }],
];

export const WRITE_MULTIPLIER: Record<CacheTtl, number> = { '5m': 1.25, '1h': 2 };

export const pricesFor = (model: string): Prices | undefined => TABLE.find(([pattern]) => pattern.test(model))?.[1];

export interface Cost {
	input: number;
	output: number;
	write: number;
	read: number;
	total: number;
}

const NONE: Cost = { input: 0, output: 0, write: 0, read: 0, total: 0 };
const perToken = (dollarsPerMillion: number) => dollarsPerMillion / 1e6;

/** What one request cost; nothing for a model with no known price. */
export function requestCost(model: string, u: TokenUsage): Cost {
	const p = pricesFor(model);
	if (!p) return NONE;
	const cost = {
		input: u.input * perToken(p.input),
		output: u.output * perToken(p.output),
		write: (u.cacheWrite['5m'] * WRITE_MULTIPLIER['5m'] + u.cacheWrite['1h'] * WRITE_MULTIPLIER['1h']) * perToken(p.input),
		read: u.cacheRead * perToken(p.read),
	};
	return { ...cost, total: cost.input + cost.output + cost.write + cost.read };
}

/** What writing `tokens` to the prompt cache costs, as after the cache expired. */
export function rewriteCost(model: string, tokens: number, ttl: CacheTtl): number {
	const p = pricesFor(model);
	return p ? tokens * perToken(p.input) * WRITE_MULTIPLIER[ttl] : 0;
}

/** What re-reading `tokens` from the cache costs once, the price of carrying context. */
export function carryCost(model: string, tokens: number): number {
	const p = pricesFor(model);
	return p ? tokens * perToken(p.read) : 0;
}
