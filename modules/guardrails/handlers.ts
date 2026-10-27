// The guardrails Module's code: the push rule on every shell command. It
// fails closed, because a guard that cannot run must not wave a push through.
import { z } from 'zod';
import { type ModuleDefinition, moduleSettings } from '../../src/core/modules.ts';
import { protectedPushes } from './push-rule.ts';

const settings = z.strictObject({
	'protected-branches': z.array(z.string().min(1)).min(1).default(['main', 'master']),
});

export const guardrailsModule = {
	name: 'guardrails',
	settings,
	// Every push the rule judges has the word in its payload.
	filters: { 'command.before': 'push' },
	failClosed: ['command.before'],
	handlers: {
		'command.before'(event, { project }) {
			if (event.name !== 'command.before') return undefined;
			const branches = moduleSettings(guardrailsModule, project)['protected-branches'];
			const reasons = protectedPushes(event.command, event.cwd, branches);
			if (!reasons.length) return undefined;
			return { block: `kalfa guardrails refused ${reasons.join('; ')}. Push another branch and open a pull request.` };
		},
	},
} satisfies ModuleDefinition & { settings: typeof settings };
