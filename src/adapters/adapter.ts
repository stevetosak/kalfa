// An Adapter only translates: a harness hook payload into a Core event, and the
// Dispatcher's merged result into what the harness reads. It holds no logic a
// Core test cannot reach.
import type { Capability } from '../core/capabilities.ts';
import type { CoreEvent, CoreEventName, DispatchResult } from '../core/events.ts';
import type { ApprovalKind, Rule } from '../core/module-source.ts';
import type { SkillSource } from '../core/skill-refs.ts';
import type { UsageSource } from '../core/usage.ts';

export interface HookOutput {
	stdout?: string;
	stderr?: string;
	exitCode: number;
}

export interface Adapter {
	/** The Harness name used on the command line, e.g. `claude`. */
	name: string;
	capabilities: ReadonlySet<Capability>;
	/** Whether a command runs inside this harness (for events the CLI raises). */
	detect(env: NodeJS.ProcessEnv): boolean;
	/** The Core event in the payload; `undefined` when the payload is not one (e.g. a tool that is not a shell). */
	toEvent(name: CoreEventName, payload: unknown): CoreEvent | undefined;
	render(event: CoreEvent, result: DispatchResult): HookOutput;
	/** Where `kalfa build` writes a Module's files for this harness; `undefined` when it has none. */
	project?: ProjectFiles;
	/** What `kalfa install` writes into the harness's user settings; `undefined` when kalfa cannot install there. */
	user?: UserFiles;
	/** Where this harness finds skills and commands, for `kalfa doctor`; `undefined` when kalfa cannot tell. */
	skills?: SkillLookup;
	/** The session a command runs inside, from the environment the harness gives its commands; `undefined` when it does not say. */
	currentSession?(env: NodeJS.ProcessEnv): string | undefined;
	/** How a new session of this harness starts; `undefined` when kalfa cannot start one. */
	session?: SessionLaunch;
	/**
	 * The token use of its sessions (with the `usage` Capability). The Adapter
	 * also ships `context-probe.sh`, which the shim runs to read the context
	 * size of the session in a hook payload without starting Node.
	 */
	usage?: UsageSource;
	/**
	 * The most characters the agent reads of one hook's context; past it the
	 * harness shows only the start. `undefined` when it has no cap.
	 */
	contextCap?: number;
}

/**
 * The harness's user settings, which kalfa shares with the Operator and other
 * tools. Each function takes the parsed file and returns it changed, or the
 * same object when nothing changes; it touches only what is kalfa's.
 */
export interface UserFiles {
	/** The settings file, relative to HOME. */
	settings: string;
	/**
	 * One hook per Core event the harness raises, each running `command(event)`;
	 * `undefined` removes kalfa's hooks. A hook is kalfa's when it runs a program
	 * named `kalfa-hook`, wherever it is.
	 */
	hooks(data: Record<string, unknown>, command: ((event: CoreEventName) => string) | undefined): Record<string, unknown>;
	/**
	 * The status line wrapped in `tap` (the Adapter's status-tap), which hands
	 * the input on to the Operator's own command; `undefined` unwraps it. Throws
	 * a KalfaError when the Operator's command cannot be wrapped.
	 */
	statusLine?(data: Record<string, unknown>, tap: string | undefined): Record<string, unknown>;
	approvals: ApprovalLayout;
	/** The settings `kalfa install` sets to kalfa's value; `uninstall` puts back the value each had. */
	owned?: readonly OwnedSetting[];
	/**
	 * The keys to the map of environment variables the harness sets for the
	 * agent's commands, e.g. `['env']`; where a machine step's `agentEnv` goes.
	 * Left out, the harness has no such map and the entries are not written.
	 */
	agentEnv?: readonly string[];
	/** Where the Personal layer's Rule pack goes, relative to HOME (ADR 0003); `undefined` puts its rules in the session report. */
	rules?: RuleLayout;
}

/**
 * A rule of a layer's Rule pack in the form the harness loads it. The Core has
 * already applied the fallbacks for the Capabilities the harness lacks.
 */
export interface LoadedRule {
	id: string;
	/** The rule's text: its first line is the rule, the rest its reasons. */
	text: string;
	/** Globs relative to the folder the session runs in; only on a rule the harness loads by path. */
	paths?: string[];
}

/** The rules of one layer that the Instruction files hold. */
export interface LayerRules {
	layer: 'personal' | 'project';
	/** How messages name the layer: `personal`, or the project key. */
	label: string;
	/** The rules that load in every session, with the pointer lines of skill-form rules where the harness has no skills. */
	always: LoadedRule[];
	/** The rules the harness loads when the agent works on a file their paths match. */
	scoped: LoadedRule[];
}

/**
 * Where a harness loads a Memory layer's rules from (ADR 0003). Paths are
 * relative to the base folder: HOME for the Personal layer, the repository
 * root for a project's layer.
 */
export interface RuleLayout {
	/** The folder of the layer's rule files; kalfa owns every file in it. */
	dir(layer: LayerRules['layer']): string;
	/** The Instruction files of the layer, each inside `dir(layer)`; none when the layer has no rule. */
	files(rules: LayerRules): { path: string; text: string }[];
	/** Where the harness finds a skill-form rule (the `skills` Capability). */
	skillDir(name: string): string;
}

/** One user setting kalfa sets, such as the switch that turns off the harness's own memory. */
export interface OwnedSetting {
	/** Its name in `install.yaml` and in the report, e.g. `native-memory`. */
	name: string;
	/** The keys to it in the settings file, e.g. `['env', 'SOME_VARIABLE']`. */
	path: readonly string[];
	value: unknown;
	/** Why kalfa sets it, for the Operator. */
	why: string;
}

/** A new session: its name and the prompt it starts on; without a prompt it waits for the Operator. */
export interface SessionStart {
	name: string;
	prompt?: string;
	model?: string;
}

export interface SessionLaunch {
	/** The program that runs the harness. */
	program: string;
	/** Its arguments for an interactive session that starts on the prompt. */
	interactive(start: SessionStart): string[];
	/** Its arguments for the same session in the background; `undefined` when the harness has no background sessions. */
	background?(start: SessionStart): string[];
}

export interface SkillLookup {
	sources(home: string, root: string): SkillSource[];
	/** The commands the harness answers itself. */
	builtins: ReadonlySet<string>;
}

/** A harness's project file layout. Paths are relative to the repository root. */
export interface ProjectFiles {
	skillDir(skill: string): string;
	rule(module: string, rule: Rule): { path: string; text: string };
	approvals: ApprovalFile;
	/**
	 * The harness's own instruction file, when it does not read `AGENTS.md`
	 * next to it, and the line that imports `AGENTS.md` into it.
	 */
	instructions?: { file: string; importLine: string };
	/** Where a project's Rule pack goes, relative to the repository root (ADR 0003); `undefined` puts its rules in the session report. */
	rules?: RuleLayout;
}

/** The harness's own file of command approvals, which kalfa shares with the Operator's entries. */
export interface ApprovalFile extends ApprovalLayout {
	path: string;
}

/** How the harness keeps command approvals in a parsed settings file. */
export interface ApprovalLayout {
	/** One command pattern in the harness's form. */
	entry(pattern: string): string;
	/** The entries of one kind in the parsed file. */
	read(data: Record<string, unknown>, kind: ApprovalKind): string[];
	/** The file with the entries of one kind replaced. */
	write(data: Record<string, unknown>, kind: ApprovalKind, entries: string[]): Record<string, unknown>;
}
