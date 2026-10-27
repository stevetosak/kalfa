// The herdr Module's code. Herdr shows each agent's state (working, blocked,
// done) through its own integration hooks, which `herdr integration install`
// owns; kalfa does not copy them. At session start inside Herdr, this Module
// only says when that integration is missing or old for the harness.
import type { ModuleDefinition } from '../../src/core/modules.ts';
import { errorText, type HerdrExec, herdrCli, inHerdr } from './launcher.ts';

/** The integration state Herdr prints for one harness, e.g. `current`; `undefined` when it lists none. */
export function integrationState(status: string, harness: string): string | undefined {
	const line = status.split('\n').find((l) => l.startsWith(`${harness}: `));
	return line?.slice(harness.length + 2).replace(/\s*\(.*$/, '');
}

export function herdrModuleWith(exec: HerdrExec): ModuleDefinition {
	return {
		name: 'herdr',
		handlers: {
			'session.start'(event, { env }) {
				if (event.name !== 'session.start' || !inHerdr(env)) return undefined;
				let state: string | undefined;
				try {
					state = integrationState(exec(['integration', 'status']), event.harness);
				} catch (error) {
					return { notice: `kalfa herdr: herdr integration status failed: ${errorText(error)}` };
				}
				if (state === 'current' || state === undefined) return undefined;
				return { notice: `kalfa herdr: Herdr's ${event.harness} integration is ${state}, so Herdr may not show this session's state. Run: herdr integration install ${event.harness}` };
			},
		},
	};
}

export const herdrModule = herdrModuleWith(herdrCli);
