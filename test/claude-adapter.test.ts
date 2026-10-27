// Adapter contract tests on payloads recorded from real Claude Code sessions
// (scripts/record-claude-fixtures.sh). Every recorded version must pass.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { CLAUDE_HOOKS, claudeAdapter } from '../src/adapters/claude/adapter.ts';
import type { CoreEvent, CoreEventName, DispatchResult } from '../src/core/events.ts';

const FIXTURES = 'test/fixtures/claude';
const versions = readdirSync(FIXTURES);
const common = {
	harness: 'claude',
	cwd: '/work/repo',
	sessionId: '00000000-0000-4000-8000-000000000000',
	transcript: '/home/operator/.claude/projects/-work-repo/00000000-0000-4000-8000-000000000000.jsonl',
};

const expected: Record<string, CoreEvent> = {
	'session.start': { ...common, name: 'session.start', source: 'startup' },
	'prompt.submit': { ...common, name: 'prompt.submit', prompt: 'Run the shell command `echo hi` with the Bash tool, then reply with the single word: done.' },
	'command.before': { ...common, name: 'command.before', command: 'echo hi' },
	'tool.after': { ...common, name: 'tool.after', tool: 'Bash', durationMs: 350 },
};

test('at least one Claude Code version is recorded', () => assert.ok(versions.length > 0));

for (const version of versions) {
	describe(`Claude Code ${version}`, () => {
		for (const [name, { hook }] of Object.entries(CLAUDE_HOOKS) as Array<[CoreEventName, { hook: string }]>) {
			const payload = JSON.parse(readFileSync(join(FIXTURES, version, `${hook}.json`), 'utf8'));
			test(`${hook} becomes ${name}`, () => assert.deepEqual(claudeAdapter.toEvent(name, payload), expected[name]));
		}

		const preToolUse = JSON.parse(readFileSync(join(FIXTURES, version, 'PreToolUse.json'), 'utf8'));
		test('a tool that is not the shell raises no command.before', () => {
			assert.equal(claudeAdapter.toEvent('command.before', { ...preToolUse, tool_name: 'Read', tool_input: { file_path: '/x' } }), undefined);
		});
		test('a hook from a subagent marks the event', () => {
			assert.equal(claudeAdapter.toEvent('command.before', { ...preToolUse, agent_id: 'a1' })?.subagent, true);
			assert.equal(claudeAdapter.toEvent('command.before', preToolUse)?.subagent, undefined);
		});
		test('a hook wired to the wrong event is refused', () => {
			assert.throws(() => claudeAdapter.toEvent('session.start', preToolUse), { name: 'KalfaError', message: /wired to the PreToolUse hook; it belongs on SessionStart/ });
		});
	});
}

test('a payload without a required field is refused with a hint', () => {
	assert.throws(() => claudeAdapter.toEvent('prompt.submit', { hook_event_name: 'UserPromptSubmit', cwd: '/' }), { message: /record new fixtures/ });
});

test('events Claude Code has no hook for are not raised by it', () => {
	assert.equal(claudeAdapter.toEvent('task.close', { hook_event_name: 'Stop', cwd: '/' }), undefined);
});

const result = (part: Partial<DispatchResult>): DispatchResult => ({ context: [], block: [], quiet: false, stop: [], notice: [], ...part });
const json = (event: CoreEvent, part: Partial<DispatchResult>) => {
	const out = claudeAdapter.render(event, result(part));
	assert.equal(out.exitCode, 0);
	return out.stdout === undefined ? undefined : JSON.parse(out.stdout);
};

test('nothing to say prints nothing', () => assert.equal(json(expected['tool.after']!, {}), undefined));

test('context becomes additionalContext, notices a systemMessage', () => {
	assert.deepEqual(json(expected['session.start']!, { context: ['a', 'b'], notice: ['n'] }), {
		systemMessage: 'n',
		hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'a\n\nb' },
	});
});

test('a block on a command is a deny with the reasons', () => {
	assert.deepEqual(json(expected['command.before']!, { block: ['no push', 'no force'], context: ['ignored'] }), {
		hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'no push\n\nno force' },
	});
});

test('a block on a prompt is a block decision', () => {
	assert.deepEqual(json(expected['prompt.submit']!, { block: ['compact first'] }), { decision: 'block', reason: 'compact first' });
});

test('a quiet block on a prompt also drops the prompt from the session', () => {
	assert.deepEqual(json(expected['prompt.submit']!, { block: ['meter off'], quiet: true }), {
		decision: 'block',
		reason: 'meter off',
		hookSpecificOutput: { hookEventName: 'UserPromptSubmit', suppressOriginalPrompt: true },
	});
});

test('a stop after a tool ends the turn, with the reasons for the Operator', () => {
	assert.deepEqual(json(expected['tool.after']!, { stop: ['paused'], context: ['note'] }), {
		continue: false,
		stopReason: 'paused',
		hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: 'note' },
	});
});
