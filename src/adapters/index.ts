import type { Adapter } from './adapter.ts';
import { claudeAdapter } from './claude/adapter.ts';

/** The Adapters this kalfa ships, by Harness name. */
export const adapters: ReadonlyMap<string, Adapter> = new Map([claudeAdapter].map((a) => [a.name, a]));
