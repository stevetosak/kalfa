// The token use of each request a session sent, in harness-neutral form. An
// Adapter with the `usage` Capability reads it from its harness's transcript;
// the `meter` Module measures the context and prices the requests with it.

/** The lifetime of the prompt cache a request wrote to. */
export type CacheTtl = '5m' | '1h';

export interface TokenUsage {
	input: number;
	output: number;
	/** Tokens written to the cache, by the cache's lifetime. */
	cacheWrite: Record<CacheTtl, number>;
	cacheRead: number;
}

/** What made the harness send the request. */
export type Trigger = 'start' | 'operator' | 'tool-result' | 'notification' | 'meta';

export interface RequestRecord {
	id: string;
	/** Epoch milliseconds. */
	at: number;
	model: string;
	usage: TokenUsage;
	/** Tokens the request sent: the whole context at that point. */
	context: number;
	trigger: Trigger;
	/** The start of the prompt that triggered it (operator, notification or meta). */
	prompt?: string;
	/** Tools the request called; a skill as `Skill:<name>`. */
	tools: string[];
}

export interface LastRequest extends RequestRecord {
	/** The cache lifetime of the newest request that wrote to the cache; one hour if none did. */
	ttl: CacheTtl;
}

/** One session's requests; a subagent has its own. */
export interface SessionUsage {
	/** A short name of the project the session ran in. */
	project: string;
	id: string;
	/** A subagent's name or type; `undefined` for a main session. */
	agent?: string;
	/** A subagent's main session. */
	parent?: string;
	requests: RequestRecord[];
}

export interface UsageSource {
	/** The session's newest request, from its transcript; `undefined` before the first one. */
	lastRequest(transcript: string): LastRequest | undefined;
	/** Every session on this machine with a request at or after `since` (epoch ms). */
	sessions(env: NodeJS.ProcessEnv, since: number): SessionUsage[];
}

export const contextOf = (u: TokenUsage): number => u.input + u.cacheWrite['5m'] + u.cacheWrite['1h'] + u.cacheRead;
