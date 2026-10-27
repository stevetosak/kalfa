// Where the usage goes. Prices each request of every session on this machine,
// main sessions and their subagents (pricing.ts), and sums it the ways that
// found the cost on 2026-10-04: main session against subagents, the size of
// the context each request carried, what woke the model, and cache writes at
// a session's start against rewrites after a pause.
import type { RequestRecord, SessionUsage, Trigger } from '../../src/core/usage.ts';
import { BASELINE, COMPACT_AT, IDLE_MS } from './budget.ts';
import { carryCost, requestCost } from './pricing.ts';

/** A cache write this large is the whole context, not the newest turn. */
const FULL_WRITE = 40_000;

const cost = (r: RequestRecord) => requestCost(r.model, r.usage).total;
const sum = (requests: RequestRecord[]) => requests.reduce((total, r) => total + cost(r), 0);
const dollars = (n: number) => `$${n.toFixed(2)}`;
const share = (part: number, whole: number) => `${whole ? Math.round((100 * part) / whole) : 0}%`;
const k = (tokens: number) => `${Math.round(tokens / 1000)}k`;
const day = (at: number) => new Date(at).toISOString().slice(0, 10);
const familyOf = (model: string) => /fable|mythos|opus|sonnet|haiku/.exec(model)?.[0] ?? model;
const written = (r: RequestRecord) => r.usage.cacheWrite['5m'] + r.usage.cacheWrite['1h'];

function grouped<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
	const groups = new Map<string, T[]>();
	for (const item of items) groups.set(key(item), [...(groups.get(key(item)) ?? []), item]);
	return groups;
}

/** Rows of `[label, requests]`, most expensive first, each with its cost and share. */
function table(rows: [string, RequestRecord[]][], whole: number): string[] {
	const width = Math.max(0, ...rows.map(([label]) => label.length));
	return rows
		.map(([label, requests]) => ({ label, requests, total: sum(requests) }))
		.sort((a, b) => b.total - a.total)
		.map(({ label, requests, total }) => `  ${label.padEnd(width)}  ${dollars(total).padStart(9)}  ${share(total, whole).padStart(4)}  ${String(requests.length).padStart(6)} requests`);
}

const mains = (sessions: SessionUsage[]) => sessions.filter((s) => !s.agent);
const all = (sessions: SessionUsage[]) => sessions.flatMap((s) => s.requests);

export function overview(sessions: SessionUsage[]): string[] {
	const whole = sum(all(sessions));
	const byRole = [...grouped(sessions, (s) => (s.agent ? 'subagents' : 'main sessions'))].map(([label, group]) => [label, all(group)] as [string, RequestRecord[]]);
	const tagged = sessions.flatMap((s) => s.requests.map((r) => ({ r, label: `${s.agent ? 'subagent' : 'main'} ${familyOf(r.model)}` })));
	const byModel = [...grouped(tagged, (x) => x.label)].map(([label, items]) => [label, items.map((x) => x.r)] as [string, RequestRecord[]]);
	const byDay = [...grouped(all(sessions), (r) => day(r.at))].sort(([a], [b]) => a.localeCompare(b));
	return [
		`Total ${dollars(whole)} API-equivalent, ${all(sessions).length} requests, ${mains(sessions).length} main sessions.`,
		'',
		'By role:',
		...table(byRole, whole),
		'',
		'By model:',
		...table(byModel, whole),
		'',
		'By day:',
		...byDay.map(([date, requests]) => `  ${date}  ${dollars(sum(requests)).padStart(9)}  ${String(requests.length).padStart(6)} requests`),
	];
}

/** What carrying the context cost: each request re-reads it, priced as a cache read. */
export function contextBands(sessions: SessionUsage[], compactAt = COMPACT_AT): string[] {
	const requests = all(mains(sessions));
	const whole = sum(requests);
	const bands = [
		[`up to ${k(BASELINE)} (the baseline)`, 0, BASELINE],
		[`${k(BASELINE)} to ${k(compactAt)}`, BASELINE, compactAt],
		[`above ${k(compactAt)} (past the compact point)`, compactAt, Number.POSITIVE_INFINITY],
	] as const;
	const parts = requests.map((r) => requestCost(r.model, r.usage));
	const output = parts.reduce((t, c) => t + c.output, 0);
	const writes = parts.reduce((t, c) => t + c.write, 0);
	return [
		`Main sessions ${dollars(whole)}. Context carried per request, priced as a cache read:`,
		...bands.map(([label, from, to]) => {
			const carried = requests.reduce((t, r) => t + carryCost(r.model, Math.max(0, Math.min(r.context, to) - from)), 0);
			return `  ${label.padEnd(38)}  ${dollars(carried).padStart(9)}  ${share(carried, whole).padStart(4)}`;
		}),
		`  ${'output (with thinking)'.padEnd(38)}  ${dollars(output).padStart(9)}  ${share(output, whole).padStart(4)}`,
		`  ${'cache writes'.padEnd(38)}  ${dollars(writes).padStart(9)}  ${share(writes, whole).padStart(4)}`,
	];
}

const TRIGGER_LABEL: Record<Trigger, string> = {
	start: 'session start',
	operator: 'operator prompt',
	'tool-result': 'tool result',
	notification: 'task notification (Monitor, background task)',
	meta: 'skill or system text',
};

/** What woke the model in main sessions. */
export function wakeups(sessions: SessionUsage[]): string[] {
	const requests = all(mains(sessions));
	return ['What woke the model (main sessions):', ...table([...grouped(requests, (r) => TRIGGER_LABEL[r.trigger])], sum(requests))];
}

/** Full-context cache writes: a session's first request, or the first after a pause past the cache lifetime. */
export function cacheWrites(sessions: SessionUsage[]): string[] {
	const starts: RequestRecord[] = [];
	const rewrites: string[] = [];
	let rewriteTotal = 0;
	for (const session of mains(sessions)) {
		session.requests.forEach((r, i) => {
			if (written(r) < FULL_WRITE || r.usage.cacheRead > written(r)) return;
			if (i === 0) return void starts.push(r);
			const idle = r.at - session.requests[i - 1]!.at;
			if (idle < IDLE_MS) return;
			const write = requestCost(r.model, r.usage).write;
			rewriteTotal += write;
			rewrites.push(`  ${new Date(r.at).toISOString().slice(0, 16)} ${session.id.slice(0, 8)}  ${k(written(r))} written  ${dollars(write)}  after ${Math.round(idle / 60_000)} min  <- ${TRIGGER_LABEL[r.trigger]}: ${(r.prompt ?? '').replace(/\s+/g, ' ').slice(0, 60)}`);
		});
	}
	const startTotal = starts.reduce((t, r) => t + requestCost(r.model, r.usage).write, 0);
	return [
		`Session starts: ${starts.length} wrote their first context, ${dollars(startTotal)} (${starts.length ? dollars(startTotal / starts.length) : '$0'} each, the price of a fresh session).`,
		`Rewrites after a pause past the cache lifetime: ${rewrites.length}, ${dollars(rewriteTotal)}.`,
		...rewrites,
	];
}

function firstPrompt(requests: RequestRecord[]): string {
	const prompt = requests.find((r) => r.trigger === 'operator' && r.prompt)?.prompt ?? '';
	return prompt.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
}

/** The main sessions that cost most, with their subagents. */
export function topSessions(sessions: SessionUsage[], top: number): string[] {
	const subagents = grouped(sessions.filter((s) => s.agent), (s) => s.parent ?? '');
	const rows = mains(sessions)
		.map((s) => {
			const subs = subagents.get(s.id) ?? [];
			const contexts = s.requests.map((r) => r.context);
			const skills = [...new Set(s.requests.flatMap((r) => r.tools).filter((t) => t.startsWith('Skill:')).map((t) => t.slice(6)))];
			return { s, subs, main: sum(s.requests), subCost: sum(all(subs)), contexts, skills };
		})
		.sort((a, b) => b.main + b.subCost - (a.main + a.subCost))
		.slice(0, top);
	return [
		'Main sessions, most expensive first (context: first / average / largest):',
		...rows.map(({ s, subs, main, subCost, contexts, skills }) =>
			[
				`  ${new Date(s.requests[0]!.at).toISOString().slice(0, 16)} ${s.id.slice(0, 8)} ${s.project}`,
				`main ${dollars(main)} (${s.requests.length} req)`,
				subs.length ? `subagents ${subs.length} ${dollars(subCost)}` : '',
				`context ${k(contexts[0]!)}/${k(contexts.reduce((t, c) => t + c, 0) / contexts.length)}/${k(Math.max(...contexts))}`,
				skills.length ? `skills ${skills.join(',')}` : '',
				`| ${firstPrompt(s.requests)}`,
			]
				.filter(Boolean)
				.join('  '),
		),
	];
}

export function report(sessions: SessionUsage[], top = 15, compactAt = COMPACT_AT): string {
	if (sessions.length === 0) return 'No requests in this period.';
	return [overview(sessions), contextBands(sessions, compactAt), wakeups(sessions), cacheWrites(sessions), topSessions(sessions, top)].map((part) => part.join('\n')).join('\n\n');
}
