// The Claude Code Adapter. Payload shapes are proven by the recorded fixtures
// in test/fixtures/claude/<version>/; output formats follow the Claude Code
// hook docs and are proven in a real session when each event is switched.
import { z } from 'zod';
import type { Capability } from '../../core/capabilities.ts';
import { KalfaError } from '../../core/errors.ts';
import type { CoreEvent, CoreEventName, DispatchResult } from '../../core/events.ts';
import type { Adapter, HookOutput, SessionStart } from '../adapter.ts';
import { CLAUDE_HOOKS } from './hooks.ts';
import { claudeProject } from './project.ts';
import { claudeSkills } from './skills.ts';
import { claudeUsage } from './transcript.ts';
import { claudeUser } from './user.ts';

export { CLAUDE_HOOKS };

const SHELL_TOOL = 'Bash';
/** Claude Code reads at most this much PreCompact output as summary instructions. */
const COMPACT_INSTRUCTIONS_MAX = 10_000;

const base = z.looseObject({
	hook_event_name: z.string(),
	cwd: z.string(),
	session_id: z.string().optional(),
	transcript_path: z.string().optional(),
	/** Set only in a subagent's hooks. */
	agent_id: z.string().optional(),
});

const payloads = {
	'session.start': base.extend({ source: z.enum(['startup', 'resume', 'clear', 'compact', 'fork']) }),
	'prompt.submit': base.extend({ prompt: z.string() }),
	'command.before': base.extend({ tool_name: z.string(), tool_input: z.looseObject({ command: z.string().optional() }) }),
	'tool.after': base.extend({ tool_name: z.string(), duration_ms: z.number().optional() }),
	'compact.before': base.extend({ trigger: z.string(), custom_instructions: z.string().nullish() }),
	'compact.after': base.extend({ trigger: z.string(), compact_summary: z.string() }),
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
	const common = { harness: 'claude', cwd: p.cwd, sessionId: p.session_id, transcript: p.transcript_path, ...(p.agent_id ? { subagent: true } : {}) };

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
		case 'tool.after': {
			const { tool_name, duration_ms } = parse(payloads[name], payload, hook);
			return { ...common, name, tool: tool_name, durationMs: duration_ms };
		}
		case 'compact.before': {
			const { trigger, custom_instructions } = parse(payloads[name], payload, hook);
			return { ...common, name, trigger, ...(custom_instructions ? { instructions: custom_instructions } : {}) };
		}
		case 'compact.after': {
			const { trigger, compact_summary } = parse(payloads[name], payload, hook);
			return { ...common, name, trigger, summary: compact_summary };
		}
		default:
			return undefined;
	}
}

/**
 * PreCompact reads plain stdout as more summary instructions, so the context
 * goes out as text and a notice goes to stderr (shown in the transcript view).
 */
function renderCompactFocus(result: DispatchResult): HookOutput {
	const focus = result.context.join('\n\n');
	const cut = focus.length > COMPACT_INSTRUCTIONS_MAX ? `${focus.slice(0, COMPACT_INSTRUCTIONS_MAX - 1)}…` : focus;
	return { stdout: cut || undefined, stderr: result.notice.length ? result.notice.join('\n') : undefined, exitCode: 0 };
}

function render(event: CoreEvent, result: DispatchResult): HookOutput {
	if (event.name === 'compact.before') return renderCompactFocus(result);
	const hookEventName = CLAUDE_HOOKS[event.name]?.hook;
	const output: Record<string, unknown> = {};
	const context = result.context.join('\n\n');
	const block = result.block.join('\n\n');
	if (result.notice.length) output.systemMessage = result.notice.join('\n');

	if (event.name === 'command.before' && block) {
		output.hookSpecificOutput = { hookEventName, permissionDecision: 'deny', permissionDecisionReason: block };
	} else if (event.name !== 'compact.after') {
		if (event.name === 'prompt.submit' && block) Object.assign(output, { decision: 'block', reason: block });
		const specific = {
			...(context ? { additionalContext: context } : {}),
			...(event.name === 'prompt.submit' && block && result.quiet ? { suppressOriginalPrompt: true } : {}),
		};
		if (Object.keys(specific).length) output.hookSpecificOutput = { hookEventName, ...specific };
	}
	if (event.name === 'tool.after' && result.stop.length) Object.assign(output, { continue: false, stopReason: result.stop.join('\n\n') });
	return { stdout: Object.keys(output).length ? JSON.stringify(output) : undefined, exitCode: 0 };
}

const sessionArgs = ({ name, prompt, model }: SessionStart) => ['-n', name, ...(model ? ['--model', model] : []), prompt];

export const claudeAdapter: Adapter = {
	name: 'claude',
	capabilities: new Set<Capability>(['context-injection', 'command-block', 'transcript', 'task-list', 'status-line', 'background-agent', 'usage', 'turn-stop', 'compaction', 'instruction-file']),
	// Claude Code sets CLAUDECODE=1 for the commands it runs.
	detect: (env) => env.CLAUDECODE === '1',
	toEvent,
	render,
	project: claudeProject,
	user: claudeUser,
	skills: claudeSkills,
	session: { program: 'claude', interactive: sessionArgs, background: (start) => ['--bg', ...sessionArgs(start)] },
	usage: claudeUsage,
	// additionalContext above 10,000 characters goes to a file; the agent sees a 2,000-character preview.
	contextCap: 10_000,
};
