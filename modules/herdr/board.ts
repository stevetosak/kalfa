// The board: every agent session Herdr runs, across its workspaces, joined
// with the Task its pane works on and the usage of its harness session. Herdr
// gives the workspaces, tabs, panes and agents; the Task comes from the pane's
// repository and branch, as `kalfa task` finds it; the context, idle time and
// cache state come from the session's transcript, through its Adapter.
// kalfa keeps no state of its own here. A workspace is finished when the
// repositories of its panes have Task Records and none of them is open; it is
// computed each time, and shown in Herdr as display-only metadata (the
// `finished` workspace token, the `task` and `next` pane tokens), which the
// Operator's sidebar rows name.
import type { Adapter } from '../../src/adapters/adapter.ts';
import { currentBranch } from '../../src/core/git.ts';
import { repoRootOf } from '../../src/core/project.ts';
import { listRecords, nextStep, readRecord, type TaskRecord, taskIdOf } from '../../src/core/task-record.ts';
import { CACHE_TTL_MS } from '../../src/core/usage.ts';
import type { HerdrExec } from './launcher.ts';

/** The `--source` of every metadata report kalfa makes. */
export const METADATA_SOURCE = 'kalfa';

/** Herdr cuts a token value at 80 characters. */
const TOKEN_MAX = 80;

/** Agent states in which closing the workspace would cut work off. */
const BUSY = new Set(['working', 'blocked']);

export interface HerdrPane {
	pane_id: string;
	tab_id: string;
	workspace_id: string;
	cwd: string;
}

export interface HerdrAgent extends HerdrPane {
	/** The agent kind, e.g. `claude`, `pi`; Herdr's names match kalfa's Adapters. */
	agent?: string;
	name?: string;
	agent_status: string;
	/** The title the harness gives its terminal, e.g. the session's name, without a leading spinner glyph. */
	terminal_title_stripped?: string;
	/** The harness session: an id (`claude`) or a transcript path (`pi`). */
	agent_session?: { kind: string; value: string };
}

export interface Snapshot {
	workspaces: { workspace_id: string; label: string }[];
	tabs: { tab_id: string; label: string }[];
	panes: HerdrPane[];
	agents: HerdrAgent[];
}

const result = <T>(exec: HerdrExec, args: string[]) => (JSON.parse(exec(args)) as { result: T }).result;

export function readSnapshot(exec: HerdrExec): Snapshot {
	return {
		workspaces: result<Pick<Snapshot, 'workspaces'>>(exec, ['workspace', 'list']).workspaces,
		tabs: result<Pick<Snapshot, 'tabs'>>(exec, ['tab', 'list']).tabs,
		panes: result<Pick<Snapshot, 'panes'>>(exec, ['pane', 'list']).panes,
		agents: result<Pick<Snapshot, 'agents'>>(exec, ['agent', 'list']).agents,
	};
}

/** The Task a pane works on: its repository, and the Task Record of the branch when there is one. */
export interface PaneTask {
	root: string;
	record?: TaskRecord;
}

/** What the board reads outside Herdr; tests give their own. */
export interface Lookups {
	taskAt(cwd: string): PaneTask | undefined;
	/** Task Records of a repository: how many, and how many are open. */
	tasksIn(root: string): { total: number; open: number };
	use(agent: HerdrAgent): SessionUse | undefined;
}

export interface SessionUse {
	/** Tokens the last request sent. */
	context: number;
	idleMs: number;
	/** The prompt cache of the last request is still alive. */
	warm: boolean;
}

/** Lookups from the disk, each repository read once per run. */
export function diskLookups(adapters: ReadonlyMap<string, Adapter>, env: NodeJS.ProcessEnv, now: number): Lookups {
	const tasks = new Map<string, PaneTask | undefined>();
	const counts = new Map<string, { total: number; open: number }>();
	return {
		taskAt(cwd) {
			const root = repoRootOf(cwd);
			if (!root) return undefined;
			if (!tasks.has(root)) {
				const branch = currentBranch(root);
				tasks.set(root, { root, record: branch ? readRecord(root, taskIdOf(branch)) : undefined });
			}
			return tasks.get(root);
		},
		tasksIn(root) {
			if (!counts.has(root)) {
				const records = listRecords(root);
				counts.set(root, { total: records.length, open: records.filter((r) => r.header.status === 'open').length });
			}
			return counts.get(root)!;
		},
		use(agent) {
			const usage = agent.agent ? adapters.get(agent.agent)?.usage : undefined;
			const session = agent.agent_session;
			if (!usage || !session) return undefined;
			const transcript = session.kind === 'path' ? session.value : usage.transcriptOf(env, session.value);
			const last = transcript ? usage.lastRequest(transcript) : undefined;
			if (!last) return undefined;
			const idleMs = Math.max(0, now - last.at);
			return { context: last.context, idleMs, warm: idleMs < CACHE_TTL_MS[last.ttl] };
		},
	};
}

/** The workspaces whose repositories have Task Records and no open one. */
export function finishedWorkspaces(snapshot: Snapshot, lookups: Pick<Lookups, 'tasksIn'>): Set<string> {
	const finished = new Set<string>();
	for (const { workspace_id } of snapshot.workspaces) {
		const roots = new Set(snapshot.panes.filter((p) => p.workspace_id === workspace_id).flatMap((p) => repoRootOf(p.cwd) ?? []));
		const counts = [...roots].map((root) => lookups.tasksIn(root)).filter((c) => c.total > 0);
		if (counts.length && counts.every((c) => c.open === 0)) finished.add(workspace_id);
	}
	return finished;
}

const taskText = (record: TaskRecord) => (record.header.status === 'open' ? record.id : `${record.id} (closed)`);

const tokens = (k: number) => `${Math.round(k / 1000)}k`;

export function duration(ms: number): string {
	const minutes = Math.floor(ms / 60_000);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	return hours < 48 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

function sessionLine(snapshot: Snapshot, agent: HerdrAgent, lookups: Lookups): string[] {
	const title = agent.terminal_title_stripped || snapshot.tabs.find((t) => t.tab_id === agent.tab_id)?.label || agent.tab_id;
	const record = lookups.taskAt(agent.cwd)?.record;
	const use = lookups.use(agent);
	const fields = [
		[agent.agent ?? 'agent', agent.name, title === agent.name ? undefined : `"${title}"`].filter(Boolean).join(' '),
		agent.agent_status,
		record ? `Task ${taskText(record)}` : 'no Task',
		use ? `${tokens(use.context)} tokens` : 'context —',
		use ? `last request ${duration(use.idleMs)} ago` : undefined,
		use ? `cache ${use.warm ? 'warm' : 'cold'}` : undefined,
	];
	const next = record?.header.status === 'open' ? nextStep(record) : undefined;
	return [`  ${fields.filter(Boolean).join(' · ')}`, ...(next ? [`    Next: ${next}`] : [])];
}

/** One block per workspace that runs an agent or is finished: its sessions, one line each, with the Task's Next. */
export function renderBoard(snapshot: Snapshot, lookups: Lookups, finished: ReadonlySet<string>): string {
	const blocks = snapshot.workspaces.flatMap(({ workspace_id, label }) => {
		const agents = snapshot.agents.filter((a) => a.workspace_id === workspace_id);
		if (!agents.length && !finished.has(workspace_id)) return [];
		const head = `${label} (${workspace_id})${finished.has(workspace_id) ? ' — finished: no open Task' : ''}`;
		return [[head, ...agents.flatMap((a) => sessionLine(snapshot, a, lookups))].join('\n')];
	});
	const count = snapshot.agents.length;
	const summary = `${count} agent session${count === 1 ? '' : 's'} in ${snapshot.workspaces.length} workspace${snapshot.workspaces.length === 1 ? '' : 's'}${finished.size ? `; ${finished.size} finished (kalfa board --clean)` : ''}.`;
	return [summary, ...blocks].join('\n\n');
}

/** Lists the finished workspaces; with `yes`, closes each one in which no agent works or waits. */
export function cleanWorkspaces(exec: HerdrExec, snapshot: Snapshot, finished: ReadonlySet<string>, yes: boolean): string[] {
	if (!finished.size) return ['No finished workspace: each one has an open Task or no Task Records.'];
	const lines: string[] = [];
	for (const { workspace_id, label } of snapshot.workspaces.filter((w) => finished.has(w.workspace_id))) {
		const agents = snapshot.agents.filter((a) => a.workspace_id === workspace_id);
		const busy = agents.filter((a) => BUSY.has(a.agent_status));
		const states = agents.length ? agents.map((a) => `${a.agent ?? 'agent'} ${a.agent_status}`).join(', ') : 'no agents';
		const where = `${label} (${workspace_id}; ${states})`;
		if (!yes) lines.push(`- ${where}`);
		else if (busy.length) lines.push(`- ${where}: kept, an agent works or waits there`);
		else {
			exec(['workspace', 'close', workspace_id]);
			lines.push(`- ${where}: closed`);
		}
	}
	if (!yes) lines.push('', 'Closing ends the sessions in them. After the Operator\'s yes: kalfa board --clean --yes');
	return lines;
}

const clip = (text: string) => (text.length > TOKEN_MAX ? `${text.slice(0, TOKEN_MAX - 1)}…` : text);

/**
 * Shows the Task of a repository in Herdr: the `task` and `next` tokens on
 * each agent pane in it, and the `finished` token on each workspace that
 * holds it. Returns the labels of those workspaces that are now finished.
 */
export function refreshLabels(exec: HerdrExec, root: string, lookups: Lookups): string[] {
	const snapshot = readSnapshot(exec);
	const record = lookups.taskAt(root)?.record;
	const next = record?.header.status === 'open' ? nextStep(record) : undefined;
	const taskTokens = [...(record ? ['--token', `task=${clip(taskText(record))}`] : ['--clear-token', 'task']), ...(next ? ['--token', `next=${clip(next)}`] : ['--clear-token', 'next'])];
	for (const agent of snapshot.agents.filter((a) => repoRootOf(a.cwd) === root)) {
		exec(['pane', 'report-metadata', agent.pane_id, '--source', METADATA_SOURCE, ...taskTokens]);
	}
	const finished = finishedWorkspaces(snapshot, lookups);
	const holding = new Set(snapshot.panes.filter((p) => repoRootOf(p.cwd) === root).map((p) => p.workspace_id));
	const done: string[] = [];
	for (const { workspace_id, label } of snapshot.workspaces.filter((w) => holding.has(w.workspace_id))) {
		const isFinished = finished.has(workspace_id);
		exec(['workspace', 'report-metadata', workspace_id, '--source', METADATA_SOURCE, ...(isFinished ? ['--token', 'finished=finished'] : ['--clear-token', 'finished'])]);
		if (isFinished) done.push(label);
	}
	return done;
}
