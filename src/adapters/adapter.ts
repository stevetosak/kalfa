// An Adapter only translates: a harness hook payload into a Core event, and the
// Dispatcher's merged result into what the harness reads. It holds no logic a
// Core test cannot reach.
import type { Capability } from '../core/capabilities.ts';
import type { CoreEvent, CoreEventName, DispatchResult } from '../core/events.ts';
import type { ApprovalKind, Rule } from '../core/module-source.ts';

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
export interface ApprovalFile {
	path: string;
	/** One command pattern in the harness's form. */
	entry(pattern: string): string;
	/** The entries of one kind in the parsed file. */
	read(data: Record<string, unknown>, kind: ApprovalKind): string[];
	/** The file with the entries of one kind replaced. */
	write(data: Record<string, unknown>, kind: ApprovalKind, entries: string[]): Record<string, unknown>;
}
