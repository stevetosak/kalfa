// A Capability is a harness feature a Module needs. An Adapter declares the
// set its harness has; `kalfa doctor` lists what a Module loses without one.

export const CAPABILITIES = {
	'context-injection': 'the agent reads text a hook prints at session start, on a prompt or after a tool',
	'command-block': 'a hook can stop a shell command before it runs',
	transcript: 'a hook can read the session transcript',
	'task-list': 'the harness shows a live task list',
	'status-line': 'the harness runs a command for its status line',
	'background-agent': 'a skill can start a background agent',
} as const;

export type Capability = keyof typeof CAPABILITIES;

export function isCapability(name: string): name is Capability {
	return Object.hasOwn(CAPABILITIES, name);
}
