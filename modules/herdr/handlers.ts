// The herdr Module's handlers. Herdr shows each agent's state (working,
// blocked, done) through its own integration hooks, which `herdr integration
// install` owns; kalfa does not copy them. At session start inside Herdr,
// this Module says when that integration is missing or old for the harness.
// At session start, Section close and Task close it shows the repository's
// Task on its agent panes and marks the workspaces whose Tasks are all closed
// (board.ts); Task close also tells the Operator about them.
import type { CoreEventName } from '../../src/core/events.ts';
import type { Handler, HandlerContext, ModuleDefinition } from '../../src/core/modules.ts';
import { diskLookups, refreshLabels } from './board.ts';
import { errorText, type HerdrExec, herdrCli, inHerdr } from './launcher.ts';

/** The integration state Herdr prints for one harness, e.g. `current`; `undefined` when it lists none. */
export function integrationState(status: string, harness: string): string | undefined {
	const line = status.split('\n').find((l) => l.startsWith(`${harness}: `));
	return line?.slice(harness.length + 2).replace(/\s*\(.*$/, '');
}

function integrationNotice(exec: HerdrExec, harness: string): string | undefined {
	let state: string | undefined;
	try {
		state = integrationState(exec(['integration', 'status']), harness);
	} catch (error) {
		return `kalfa herdr: herdr integration status failed: ${errorText(error)}`;
	}
	if (state === 'current' || state === undefined) return undefined;
	return `kalfa herdr: Herdr's ${harness} integration is ${state}, so Herdr may not show this session's state. Run: herdr integration install ${harness}`;
}

/** The labels of the repository's panes and workspaces; a notice when Herdr refused them, or when a workspace is finished after a Task close. */
function labelNotice(exec: HerdrExec, event: CoreEventName, { project, env }: HandlerContext): string | undefined {
	if (!project) return undefined;
	let finished: string[];
	try {
		finished = refreshLabels(exec, project.root, diskLookups(new Map(), env, Date.now()));
	} catch (error) {
		return `kalfa herdr: the Task labels failed: ${errorText(error)}`;
	}
	if (event !== 'task.close' || !finished.length) return undefined;
	return `kalfa herdr: workspace ${finished.join(', ')} has no open Task left. Tell the Operator; \`kalfa board --clean\` lists it, and it closes only after their yes.`;
}

export function herdrModuleWith(exec: HerdrExec): ModuleDefinition {
	const labels: Handler = (event, context) => {
		if (!inHerdr(context.env)) return undefined;
		const notice = labelNotice(exec, event.name, context);
		return notice ? { notice } : undefined;
	};
	return {
		name: 'herdr',
		handlers: {
			'session.start'(event, context) {
				if (event.name !== 'session.start' || !inHerdr(context.env)) return undefined;
				const notice = [integrationNotice(exec, event.harness), labelNotice(exec, event.name, context)].filter(Boolean).join('\n');
				return notice ? { notice } : undefined;
			},
			'section.close': labels,
			'task.close': labels,
		},
	};
}

export const herdrModule = herdrModuleWith(herdrCli);
