// What `kalfa install` writes into `~/.claude/settings.json`: one hook per Core
// event, the status-tap wrapped around the Operator's status line, the
// machine Modules' approvals and the settings kalfa owns. Every other entry stays as it is, and the order
// of the other tools' hooks is kept.
import { basename } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { parse } from 'shell-quote';
import { KalfaError } from '../../core/errors.ts';
import type { CoreEventName } from '../../core/events.ts';
import type { UserFiles } from '../adapter.ts';
import { CLAUDE_HOOKS } from './hooks.ts';
import { claudeApprovals } from './project.ts';

/** The shim and the status tap, by the name of the program they run. */
const SHIM = 'kalfa-hook';
const TAP = 'status-tap';
const HOOK_TIMEOUT = 10;

type Data = Record<string, unknown>;

const isObject = (value: unknown): value is Data => typeof value === 'object' && value !== null && !Array.isArray(value);

/** The first word of a shell command line, quoted or not, and the text after it. */
function splitFirstWord(command: string): { first: string; rest: string } | undefined {
	const match = /^\s*('[^']*'|"[^"]*"|[^\s'"]+)\s*/.exec(command);
	if (!match) return undefined;
	const [word] = parse(match[1]!);
	return typeof word === 'string' ? { first: word, rest: command.slice(match[0].length) } : undefined;
}

const runs = (command: unknown, program: string): boolean => typeof command === 'string' && basename(splitFirstWord(command)?.first ?? '') === program;

/** The hook groups of one hook name without kalfa's hooks; groups left empty go. */
function withoutKalfa(groups: unknown): unknown {
	if (!Array.isArray(groups)) return groups;
	return groups.flatMap((group) => {
		if (!isObject(group) || !Array.isArray(group.hooks)) return [group];
		const hooks = group.hooks.filter((hook) => !(isObject(hook) && runs(hook.command, SHIM)));
		if (hooks.length === group.hooks.length) return [group];
		return hooks.length ? [{ ...group, hooks }] : [];
	});
}

function setHooks(data: Data, command: ((event: CoreEventName) => string) | undefined): Data {
	const before = isObject(data.hooks) ? data.hooks : {};
	const hooks: Data = {};
	for (const [name, groups] of Object.entries(before)) {
		const kept = withoutKalfa(groups);
		if (!Array.isArray(kept) || kept.length || !Array.isArray(groups) || !groups.length) hooks[name] = kept;
	}
	if (command) {
		for (const [event, { hook, matcher }] of Object.entries(CLAUDE_HOOKS) as Array<[CoreEventName, { hook: string; matcher?: string }]>) {
			const group = { ...(matcher ? { matcher } : {}), hooks: [{ type: 'command', command: command(event), timeout: HOOK_TIMEOUT }] };
			hooks[hook] = [...(Array.isArray(hooks[hook]) ? hooks[hook] : []), group];
		}
	}
	const result: Data = { ...data, hooks };
	if (!Object.keys(hooks).length) delete result.hooks;
	return isDeepStrictEqual(result, data) ? data : result;
}

/** Why the status tap cannot run `command` as its arguments, or `undefined` when it can. */
function unwrappable(command: string): string | undefined {
	const tokens = parse(command);
	const operator = tokens.find((token) => typeof token !== 'string');
	if (operator) return `it uses the shell operator ${JSON.stringify(operator)}`;
	if (typeof tokens[0] === 'string' && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0])) return 'it starts with a variable assignment';
	return undefined;
}

function setStatusLine(data: Data, tap: string | undefined): Data {
	const line = data.statusLine;
	if (line === undefined) return tap ? { ...data, statusLine: { type: 'command', command: tap } } : data;
	if (!isObject(line) || line.type !== 'command' || typeof line.command !== 'string') {
		if (!tap) return data;
		throw new KalfaError('the status line is not a command, so kalfa cannot wrap it to save the usage limits');
	}
	const own = runs(line.command, TAP) ? splitFirstWord(line.command)!.rest : line.command;
	if (!tap) {
		if (own === line.command) return data;
		if (!own) {
			const { statusLine: _, ...rest } = data;
			return rest;
		}
		return { ...data, statusLine: { ...line, command: own } };
	}
	if (own) {
		const why = unwrappable(own);
		if (why) throw new KalfaError(`the status line command cannot be wrapped: ${why}; put it in a script and run kalfa install again`);
	}
	const command = own ? `${tap} ${own}` : tap;
	return command === line.command ? data : { ...data, statusLine: { ...line, command } };
}

export const claudeUser: UserFiles = {
	settings: '.claude/settings.json',
	// Claude Code loads every file in ~/.claude/rules/ in full, before the project's rules.
	instructions: '.claude/rules/kalfa-memory.md',
	hooks: setHooks,
	statusLine: setStatusLine,
	approvals: claudeApprovals,
	owned: [
		// Auto memory (code.claude.com/docs/en/memory): the `/memory` toggle saves this key.
		{ name: 'native-memory', path: ['autoMemoryEnabled'], value: false, why: "kalfa's Standing memory replaces it (ADR 0002)" },
		// Idle compaction runs about an hour after the last turn, before the prompt
		// cache ends; by default only from 200k tokens. 100k is the lowest it takes.
		{
			name: 'idle-compact',
			path: ['env', 'CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS'],
			value: '100000',
			why: 'an idle session from 100k tokens is compacted before its prompt cache ends, and the Task gets a Checkpoint',
		},
	],
};
