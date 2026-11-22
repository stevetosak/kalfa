// The guardrails Module's code: the shell rule on every shell command
// (shell-rule.ts). The push check itself runs in the agent's pre-push hook
// (git-hooks.ts, `kalfa guardrails pre-push`), which reads the protected
// branches from the settings below. The rule fails closed, because a guard
// that cannot run must not wave a command through.
import { z } from 'zod';
import type { ModuleDefinition } from '../../src/core/modules.ts';
import { hookSkips } from './shell-rule.ts';

const settings = z.strictObject({
	'protected-branches': z.array(z.string().min(1)).min(1).default(['main', 'master']),
});

export const guardrailsModule = {
	name: 'guardrails',
	settings,
	// Every command the rule refuses has one of these words in its payload (core.hooksPath in any case).
	filters: { 'command.before': 'push|GIT_CONFIG_|[Hh][Oo][Oo][Kk][Ss][Pp][Aa][Tt][Hh]' },
	failClosed: ['command.before'],
	handlers: {
		'command.before'(event) {
			if (event.name !== 'command.before') return undefined;
			const reasons = hookSkips(event.command);
			if (!reasons.length) return undefined;
			return {
				block: `kalfa guardrails refused: ${reasons.join('; ')}. The agent's git runs the push check in its hooks; run the command without this part. A text that only names these words goes in a file (Write tool), not on the command line.`,
			};
		},
	},
} satisfies ModuleDefinition & { settings: typeof settings };
