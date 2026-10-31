// The Claude Code hooks that raise the Core events.
import type { CoreEventName } from '../../core/events.ts';

/** The Claude Code hook (and tool matcher) that raises each Core event. */
export const CLAUDE_HOOKS: Partial<Record<CoreEventName, { hook: string; matcher?: string }>> = {
	'session.start': { hook: 'SessionStart' },
	'prompt.submit': { hook: 'UserPromptSubmit' },
	'command.before': { hook: 'PreToolUse', matcher: 'Bash' },
	'tool.after': { hook: 'PostToolUse' },
};
