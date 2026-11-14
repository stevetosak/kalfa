// A Module's own part of `kalfa install` / `uninstall`: something on the
// machine outside the harnesses' user settings, such as the herdr Module's
// Herdr plugin. Install runs the step of each machine Module that is on;
// uninstall runs every step, because a Module switched off after the install
// still left its part behind. A step removes only what is kalfa's.

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
}
