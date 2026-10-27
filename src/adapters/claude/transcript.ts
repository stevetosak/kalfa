// Claude Code keeps each session as a JSONL transcript, one line per message
// part, so one API request spans several lines that repeat its requestId and
// usage. These helpers fold the lines into one record per request: the
// meter reads the last one, the usage report reads them all. Subagents keep
// their own transcripts under `<session>/subagents/`.
import { closeSync, existsSync, fstatSync, openSync, readdirSync, readFileSync, readSync } from 'node:fs';
import { join } from 'node:path';
import { type CacheTtl, contextOf, type LastRequest, type RequestRecord, type SessionUsage, type TokenUsage, type Trigger, type UsageSource } from '../../core/usage.ts';

/** The `usage` object of one API request, as the transcript records it. */
interface ClaudeUsage {
	input_tokens?: number;
	output_tokens?: number;
	cache_creation_input_tokens?: number;
	cache_read_input_tokens?: number;
	cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number };
}

const PROMPT_CHARS = 200;

/** Old transcripts carry no split of the cache writes: they count at the five-minute lifetime. */
export function tokenUsage(u: ClaudeUsage): TokenUsage {
	const split = u.cache_creation;
	return {
		input: u.input_tokens ?? 0,
		output: u.output_tokens ?? 0,
		cacheWrite: {
			'5m': split ? (split.ephemeral_5m_input_tokens ?? 0) : (u.cache_creation_input_tokens ?? 0),
			'1h': split?.ephemeral_1h_input_tokens ?? 0,
		},
		cacheRead: u.cache_read_input_tokens ?? 0,
	};
}

function cacheTtlOf(u: TokenUsage): CacheTtl | undefined {
	if (u.cacheWrite['1h'] > 0) return '1h';
	if (u.cacheWrite['5m'] > 0) return '5m';
	return undefined;
}

interface Line {
	type?: string;
	isMeta?: boolean;
	isSidechain?: boolean;
	timestamp?: string;
	requestId?: string;
	uuid?: string;
	message?: { id?: string; model?: string; usage?: ClaudeUsage; content?: unknown };
}

interface Block {
	type?: string;
	text?: string;
	name?: string;
	input?: { skill?: string };
}

const blocksOf = (content: unknown): Block[] => (Array.isArray(content) ? (content as Block[]) : []);

/** The trigger a user line sets for the next request, and its text. */
function triggerOf(line: Line): { trigger: Trigger; prompt?: string } {
	const content = line.message?.content;
	const blocks = blocksOf(content);
	if (blocks.some((b) => b.type === 'tool_result')) return { trigger: 'tool-result' };
	const text = typeof content === 'string' ? content : blocks.map((b) => b.text ?? '').join(' ');
	const prompt = text.trim().slice(0, PROMPT_CHARS);
	if (line.isMeta) return { trigger: 'meta', prompt };
	if (prompt.startsWith('<task-notification>')) return { trigger: 'notification', prompt };
	return { trigger: 'operator', prompt };
}

const toolsOf = (content: unknown): string[] =>
	blocksOf(content)
		.filter((b) => b.type === 'tool_use' && b.name)
		.map((b) => (b.name === 'Skill' && b.input?.skill ? `Skill:${b.input.skill}` : b.name!));

/**
 * One record per API request, in order; empty (synthetic) requests are left
 * out. A subagent's own transcript marks every line as a side chain; in a main
 * transcript such lines belong to an old-style embedded subagent and are left out.
 */
export function parseRequests(lines: Iterable<string>, { subagent = false } = {}): RequestRecord[] {
	const byId = new Map<string, RequestRecord>();
	let pending: { trigger: Trigger; prompt?: string } = { trigger: 'start' };
	for (const raw of lines) {
		if (!raw.includes('"type":"user"') && !raw.includes('"usage"')) continue;
		let line: Line;
		try {
			line = JSON.parse(raw) as Line;
		} catch {
			continue;
		}
		if (line.isSidechain && !subagent) continue;
		if (line.type === 'user') {
			pending = triggerOf(line);
			continue;
		}
		const recorded = line.message?.usage;
		if (line.type !== 'assistant' || !recorded) continue;
		const usage = tokenUsage(recorded);
		if (contextOf(usage) === 0) continue;
		const id = line.requestId ?? line.message?.id ?? line.uuid ?? String(byId.size);
		const known = byId.get(id);
		if (known) {
			known.tools.push(...toolsOf(line.message?.content));
			continue;
		}
		byId.set(id, {
			id,
			at: Date.parse(line.timestamp ?? '') || 0,
			model: line.message?.model ?? 'unknown',
			usage,
			context: contextOf(usage),
			...pending,
			tools: toolsOf(line.message?.content),
		});
	}
	return [...byId.values()];
}

export const readRequests = (path: string, options: { subagent?: boolean } = {}): RequestRecord[] => parseRequests(readFileSync(path, 'utf8').split('\n'), options);

/** The last `bytes` of a file, without its first (possibly cut) line. */
function tailLines(path: string, bytes: number): { lines: string[]; whole: boolean } {
	const fd = openSync(path, 'r');
	try {
		const size = fstatSync(fd).size;
		const start = Math.max(0, size - bytes);
		const buffer = Buffer.alloc(size - start);
		readSync(fd, buffer, 0, buffer.length, start);
		const lines = buffer.toString('utf8').split('\n');
		return { lines: start > 0 ? lines.slice(1) : lines, whole: start === 0 };
	} finally {
		closeSync(fd);
	}
}

const TAILS = [512 * 1024, 4 * 1024 * 1024];

/** The session's newest request, read from the end of its transcript. */
export function lastRequest(path: string): LastRequest | undefined {
	if (!existsSync(path)) return undefined;
	for (const bytes of [...TAILS, Number.POSITIVE_INFINITY]) {
		const { lines, whole } = tailLines(path, bytes);
		const requests = parseRequests(lines);
		const last = requests.at(-1);
		if (last) {
			const ttl = requests.map((r) => cacheTtlOf(r.usage)).findLast((t) => t !== undefined) ?? '1h';
			return { ...last, ttl };
		}
		if (whole) return undefined;
	}
	return undefined;
}

export const projectsDir = (env: NodeJS.ProcessEnv) => env.CLAUDE_PROJECTS_DIR ?? join(env.HOME ?? '', '.claude', 'projects');

/** `-home-op-Projects-Active-kalfa` → `kalfa`. */
const projectName = (folder: string) => folder.replace(/^-home-[^-]+-/, '').replace(/^Projects-(Active-)?/, '') || folder;

function subagentName(transcript: string): string {
	try {
		const meta = JSON.parse(readFileSync(transcript.replace(/\.jsonl$/, '.meta.json'), 'utf8')) as { name?: string; agentType?: string };
		return meta.name ?? meta.agentType ?? 'subagent';
	} catch {
		return 'subagent';
	}
}

const jsonl = (dir: string) => (existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.jsonl')) : []);

/** Every session under the projects folder with a request at or after `since`, main sessions and their subagents. */
export function loadSessions(root: string, since = 0): SessionUsage[] {
	const sessions: SessionUsage[] = [];
	const add = (session: Omit<SessionUsage, 'requests'>, path: string) => {
		const requests = readRequests(path, { subagent: session.agent !== undefined }).filter((r) => r.at >= since);
		if (requests.length) sessions.push({ ...session, requests });
	};
	if (!existsSync(root)) return sessions;
	for (const folder of readdirSync(root)) {
		const project = projectName(folder);
		for (const file of jsonl(join(root, folder))) {
			const id = file.replace(/\.jsonl$/, '');
			add({ project, id }, join(root, folder, file));
			const subagents = join(root, folder, id, 'subagents');
			for (const sub of jsonl(subagents)) {
				const path = join(subagents, sub);
				add({ project, id: sub.replace(/\.jsonl$/, ''), agent: subagentName(path), parent: id }, path);
			}
		}
	}
	return sessions;
}

export const claudeUsage: UsageSource = {
	lastRequest,
	sessions: (env, since) => loadSessions(projectsDir(env), since),
};
