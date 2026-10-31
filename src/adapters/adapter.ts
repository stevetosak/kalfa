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
	/** How a new session of this harness starts; `undefined` when kalfa cannot start one. */
	session?: SessionLaunch;
	/**
	 * The token use of its sessions (with the `usage` Capability). The Adapter
	 * also ships `context-probe.sh`, which the shim runs to read the context
	 * size of the session in a hook payload without starting Node.
	 */
	usage?: UsageSource;
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
}

/** A new session: its name and the prompt it starts on. */
export interface SessionStart {
	name: string;
	prompt: string;
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
