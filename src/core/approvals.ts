// Command approvals that kalfa shares with the Operator in one harness file.
// kalfa adds what the Modules want and removes only what it added before, so
// an entry the Operator wrote is never taken away. `kalfa build` uses it for a
// repository, `kalfa install` for the user settings.
import type { ApprovalLayout } from '../adapters/adapter.ts';
import { APPROVAL_KINDS, type Approvals, type ModuleSource } from './module-source.ts';

export const noApprovals = (): Approvals => ({ allow: [], ask: [], deny: [] });

/** The approvals the Modules want, in the harness's form, without repeats. */
export function planApprovals(sources: ModuleSource[], layout: ApprovalLayout): Approvals {
	const approvals = noApprovals();
	for (const source of sources) {
		for (const kind of APPROVAL_KINDS) {
			for (const pattern of source.manifest.commands[kind]) {
				const entry = layout.entry(pattern);
				if (!approvals[kind].includes(entry)) approvals[kind].push(entry);
			}
		}
	}
	return approvals;
}

export interface MergedApprovals {
	/** The file's data with the approvals merged; the same object when nothing changed. */
	after: Record<string, unknown>;
	/** The entries kalfa added and that are still there: the next run may remove them. */
	owned: Approvals;
	report: string[];
}

/** Brings the approvals in `before` to `want`; `added` is what kalfa added on its last run. */
export function mergeApprovals(before: Record<string, unknown>, layout: ApprovalLayout, want: Approvals, added: Approvals = noApprovals()): MergedApprovals {
	let after = before;
	const owned = noApprovals();
	const report: string[] = [];
	for (const kind of APPROVAL_KINDS) {
		const present = layout.read(before, kind);
		const kept = present.filter((entry) => want[kind].includes(entry) || !added[kind].includes(entry));
		const fresh = want[kind].filter((entry) => !present.includes(entry));
		owned[kind] = [...added[kind].filter((entry) => want[kind].includes(entry) && present.includes(entry)), ...fresh];
		for (const entry of present.filter((e) => !kept.includes(e))) report.push(`approvals: remove ${kind} ${entry}`);
		for (const entry of fresh) report.push(`approvals: add ${kind} ${entry}`);
		if (kept.length !== present.length || fresh.length) after = layout.write(after, kind, [...kept, ...fresh]);
	}
	return { after, owned, report };
}
