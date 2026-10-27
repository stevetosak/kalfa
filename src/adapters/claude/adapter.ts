// The Claude Code Adapter. Payload shapes are proven by the recorded fixtures
// in test/fixtures/claude/<version>/; output formats follow the Claude Code
// hook docs and are proven in a real session when each event is switched.
import { z } from 'zod';
import type { Capability } from '../../core/capabilities.ts';
import { KalfaError } from '../../core/errors.ts';
import type { CoreEvent, CoreEventName, DispatchResult } from '../../core/events.ts';
import type { Adapter, HookOutput } from '../adapter.ts';

/** The Claude Code hook (and tool matcher) that raises each Core event. */
export const CLAUDE_HOOKS: Partial<Record<CoreEventName, { hook: string; matcher?: string }>> = {
	'session.start': { hook: 'SessionStart' },
	'prompt.submit': { hook: 'UserPromptSubmit' },
	'command.before': { hook: 'PreToolUse', matcher: 'Bash' },
	'tool.after': { hook: 'PostToolUse' },
};

const SHELL_TOOL = 'Bash';

const base = z.looseObject({
	hook_event_name: z.string(),
	cwd: z.string(),
	session_id: z.string().optional(),
	transcript_path: z.string().optional(),
});

const payloads = {
	'session.start': base.extend({ source: z.enum(['startup', 'resume', 'clear', 'compact']) }),
	'prompt.submit': base.extend({ prompt: z.string() }),
	'command.before': base.extend({ tool_name: z.string(), tool_input: z.looseObject({ command: z.string().optional() }) }),
	'tool.after': base.extend({ tool_name: z.string() }),
};

function parse<S extends z.ZodType>(schema: S, payload: unknown, hook: string): z.infer<S> {
	const result = schema.safeParse(payload);
	if (!result.success) throw new KalfaError(`the ${hook} payload does not match this Adapter (record new fixtures?):\n${z.prettifyError(result.error)}`);
	return result.data;
}

function toEvent(name: CoreEventName, payload: unknown): CoreEvent | undefined {
	const hook = CLAUDE_HOOKS[name]?.hook;
	if (!hook) return undefined;
	const p = parse(base, payload, hook);
	if (p.hook_event_name !== hook) throw new KalfaError(`${name} is wired to the ${p.hook_event_name} hook; it belongs on ${hook}`);
	const common = { harness: 'claude', cwd: p.cwd, sessionId: p.session_id, transcript: p.transcript_path };

	switch (name) {
		case 'session.start':
			return { ...common, name, source: parse(payloads[name], payload, hook).source };
		case 'prompt.submit':
			return { ...common, name, prompt: parse(payloads[name], payload, hook).prompt };
		case 'command.before': {
			const { tool_name, tool_input } = parse(payloads[name], payload, hook);
			if (tool_name !== SHELL_TOOL || tool_input.command === undefined) return undefined;
			return { ...common, name, command: tool_input.command };
		}
		case 'tool.after':
			return { ...common, name, tool: parse(payloads[name], payload, hook).tool_name };
		default:
			return undefined;
	}
}

function render(event: CoreEvent, result: DispatchResult): HookOutput {
	const hookEventName = CLAUDE_HOOKS[event.name]?.hook;
	const output: Record<string, unknown> = {};
	const context = result.context.join('\n\n');
	const block = result.block.join('\n\n');
	if (result.notice.length) output.systemMessage = result.notice.join('\n');

	if (event.name === 'command.before' && block) {
		output.hookSpecificOutput = { hookEventName, permissionDecision: 'deny', permissionDecisionReason: block };
	} else {
		if (event.name === 'prompt.submit' && block) Object.assign(output, { decision: 'block', reason: block });
		if (context) output.hookSpecificOutput = { hookEventName, additionalContext: context };
	}
	return { stdout: Object.keys(output).length ? JSON.stringify(output) : undefined, exitCode: 0 };
}

export const claudeAdapter: Adapter = {
	name: 'claude',
	capabilities: new Set<Capability>(['context-injection', 'command-block', 'transcript', 'task-list', 'status-line', 'background-agent']),
	toEvent,
	render,
};
