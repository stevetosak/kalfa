// `kalfa guardrails pre-push <remote> [<url>]`: the check the agent's pre-push
// hook runs (git-hooks.ts). It reads the refs on stdin and refuses, with exit
// code 1, a push that writes a protected branch of this repository's settings.
import { type Command, UsageError } from '../../src/cli/command.ts';
import { moduleSettings } from '../../src/core/modules.ts';
import { loadProject } from '../../src/core/project.ts';
import { loadSettings } from '../../src/core/settings.ts';
import { guardrailsModule } from './handlers.ts';
import { protectedRefs } from './pre-push.ts';

export function guardrailsCommand(): Command {
	return {
		summary: "The push check of the agent's pre-push hook: refuses a push to a protected branch",
		usage: 'kalfa guardrails pre-push <remote> [<url>]   (the refs on stdin, as git hands them to the hook)',
		async run(args, io) {
			const [verb, remote] = args;
			if (verb !== 'pre-push' || !remote) throw new UsageError('kalfa guardrails pre-push <remote> [<url>]');
			const branches = moduleSettings(guardrailsModule, loadProject(io.cwd), loadSettings(io.env))['protected-branches'];
			const reasons = protectedRefs(await io.stdin(), branches);
			if (!reasons.length) return 0;
			io.err(`kalfa guardrails refused ${reasons.join('; ')} (remote ${remote}). Push another branch and open a pull request.`);
			return 1;
		},
	};
}
