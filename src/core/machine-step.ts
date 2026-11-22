// A Module's own part of `kalfa install` / `uninstall`: something on the
// machine outside the harnesses' user settings, such as the herdr Module's
// Herdr plugin. Install runs the step of each machine Module that is on;
// uninstall runs every step, because a Module switched off after the install
// still left its part behind. A step removes only what is kalfa's. A step can
// also ask for entries in the environment of the agent's commands (the
// guardrails Module's git hooks folder); install writes them into each
// harness's user settings with the rest, and uninstall puts back what was there.

export interface MachineStepContext {
	env: NodeJS.ProcessEnv;
	/** The Module's folder, where its shipped files are. */
	moduleDir: string;
	dryRun: boolean;
}

export interface MachineStep {
	/** Sets the Module's part up; returns the report lines. */
	install(context: MachineStepContext): string[];
	/** Removes the Module's part; returns the report lines. */
	uninstall(context: MachineStepContext): string[];
	/** The entries the step wants in the environment of the agent's commands, by variable name. */
	agentEnv?(context: MachineStepContext): Record<string, string>;
}

/** One step made of several: install runs them in order, uninstall in reverse order. */
export function machineStepOf(...steps: MachineStep[]): MachineStep {
	return {
		install: (context) => steps.flatMap((step) => step.install(context)),
		uninstall: (context) => [...steps].reverse().flatMap((step) => step.uninstall(context)),
		agentEnv: (context) => Object.assign({}, ...steps.map((step) => step.agentEnv?.(context) ?? {})),
	};
}
