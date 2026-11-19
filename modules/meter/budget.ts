// The context sizes and the pause the meter acts on, shared with the usage
// report that measures against them. A fresh session starts at about 65k
// tokens, and the cost of every request keeps rising with the context
// (measured 2026-10-04): the Operator compacts by hand before the harness's
// auto-compaction fires, so the meter reminds the Operator; it never hands off.

/** The default compact point: the meter first reminds the Operator to compact at the end of the current Section. */
export const COMPACT_AT = 150_000;
/** From the compact point plus this, the meter reminds the Operator to compact now, and again every REPEAT_EVERY tokens. */
export const COMPACT_NOW_AFTER = 50_000;
export const REPEAT_EVERY = 50_000;
/** Below this, writing the whole context again costs less than a guard is worth; the shim leaves Node asleep. */
export const GUARD_FROM = 100_000;
/**
 * Auto mode: from this context every Section close resets the session unless
 * the agent passes --keep. A Reset writes a fresh start of about 57k tokens,
 * so below this it saves almost nothing. A first value, tuned from resets.jsonl.
 */
export const RESET_FROM = 100_000;
/** Auto mode: from this context, and again every LARGE_EVERY, the agent gets a note; nothing resets. A first value. */
export const LARGE_AT = 300_000;
export const LARGE_EVERY = 100_000;
/** The one-hour prompt-cache lifetime of a main session on a subscription. */
export const IDLE_MS = 60 * 60 * 1000;
/** The context a fresh session starts with (system prompt, tools, memory), measured 2026-10-04. */
export const BASELINE = 65_000;
