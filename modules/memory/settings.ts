// The memory Module's settings: `settings.memory` in the machine settings or
// in `kalfa.yaml` (ADR 0002). The Core's Standing-memory budgets are not here;
// they are Core settings.
import { z } from 'zod';

/** Days after its last confirm when a record counts as stale; `null` is no limit. */
const ageLimit = z.number().int().positive().nullable();

export const memorySettings = z.strictObject({
	/** Search with each prompt too, not only at session start (a trial; off by default). */
	'recall-on-prompt': z.boolean().default(false),
	/** How many hits a recall injects. */
	'recall-hits': z.number().int().min(1).max(20).default(5),
	/** The lint's age limits per record type. A decision changes by a supersede, so it has none. */
	'age-limits': z
		.strictObject({
			rule: ageLimit.default(180),
			fact: ageLimit.default(90),
			decision: ageLimit.default(null),
			open: ageLimit.default(30),
		})
		.prefault({}),
	/** Globs (from the repository root) of old memory archives to search; they are often not tracked by git. */
	archives: z.array(z.string().min(1)).default(['.claude/*-history.md']),
});

export type MemorySettings = z.infer<typeof memorySettings>;
