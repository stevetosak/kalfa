// The Root Hub of a Memory layer: the top Hub, a short map of the layer that
// loads at every session start (ADR 0003). It is the record `root`, or, after
// supersedes, the record at the end of the chain that starts there, so the
// Hub keeps its place when a supersede gives it a new id. The memory Module
// loads it; the Core only finds it, to leave out the layer's index lines and
// to keep room for it in the session report.
import type { MemoryRecord } from './record.ts';

/** The id a layer's Root Hub starts with. */
export const ROOT_HUB_ID = 'root';

/**
 * The record at the end of the supersede chain that starts at `root`, of any
 * type and status; `undefined` when the layer has no `root` record, or when
 * the chain names a record that is not there or comes back on itself.
 */
export function rootRecord(records: readonly MemoryRecord[]): MemoryRecord | undefined {
	const byId = new Map(records.map((r) => [r.id, r]));
	const seen = new Set<string>();
	let record = byId.get(ROOT_HUB_ID);
	while (record && record.header.status === 'superseded') {
		seen.add(record.id);
		const next = record.header['superseded-by'];
		record = next && !seen.has(next) ? byId.get(next) : undefined;
	}
	return record;
}

/** The layer's Root Hub: its root record when that is an active Hub. */
export function rootHubOf(records: readonly MemoryRecord[]): MemoryRecord | undefined {
	const record = rootRecord(records);
	return record?.header.status === 'active' && record.header.type === 'hub' ? record : undefined;
}
