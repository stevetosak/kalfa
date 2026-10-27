// `kalfa task` and `kalfa section`: the agent writes the Task Record through
// these commands, so the record stays valid and the Core events are raised on
// every harness.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Adapter } from '../../adapters/adapter.ts';
import { KalfaError } from '../../core/errors.ts';
import { parsePlan } from '../../core/plans.ts';
import { currentBranch } from '../../core/git.ts';
import type { ModuleDefinition } from '../../core/modules.ts';
import type { Project } from '../../core/project.ts';
import { handoffView, listRecords, parseParts, readRecord, sectionParts, type TaskRecord, taskIdOf, writeRecord } from '../../core/task-record.ts';
import { type Command, parseCommandArgs, UsageError } from '../command.ts';
import type { Io } from '../io.ts';
import { requireProject } from '../project.ts';
import { raise, report } from '../raise.ts';

const taskOption = { task: { type: 'string' } } as const;

/** The Task named by --task, else the one of the checked-out branch. */
export function taskId(project: Project, flag: string | undefined): string {
	if (flag) return taskIdOf(flag);
	const branch = currentBranch(project.root);
	if (!branch) throw new KalfaError('no branch is checked out; name the Task with --task <id>');
	return taskIdOf(branch);
}

export function openRecord(project: Project, id: string): TaskRecord {
	const record = readRecord(project.root, id);
	if (!record) throw new KalfaError(`no Task Record '${id}'; start one with: kalfa task start "<goal>"`);
	if (record.header.status !== 'open') throw new KalfaError(`Task '${id}' is closed`);
	return record;
}

/** A Task names its Plan by path from the repository root; the page must be a Plan. */
function requirePlan(project: Project, path: string): void {
	const file = join(project.root, path);
	if (!existsSync(file)) throw new KalfaError(`--plan: no file '${path}' (give the path from the repository root)`);
	if (!parsePlan(readFileSync(file, 'utf8'), path)) throw new KalfaError(`--plan: '${path}' is not a Plan (no \`type: plan\` frontmatter)`);
}

const today = () => new Date().toLocaleDateString('sv-SE');

export function taskCommand(adapters: ReadonlyMap<string, Adapter>, registry: ReadonlyMap<string, ModuleDefinition>): Command {
	const subcommands: Record<string, (args: string[], io: Io) => Promise<number>> = {
		async start(args, io) {
			const { values, positionals } = parseCommandArgs(args, { ...taskOption, plan: { type: 'string' } }, true);
			const goal = positionals.join(' ').trim();
			if (!goal) throw new UsageError('give the Task goal');
			const project = requireProject(io);
			const id = taskId(project, values.task);
			if (values.plan) requirePlan(project, values.plan);
			const existing = readRecord(project.root, id);
			if (existing) throw new KalfaError(`Task '${id}' already exists (${existing.header.status}); name another with --task <id>`);
			const path = writeRecord(project.root, {
				id,
				header: { schema: 1, goal, branch: currentBranch(project.root), plan: values.plan, status: 'open', started: today() },
				sections: [],
			});
			io.out(`Task ${id} started: ${path}`);
			return 0;
		},
		async close(args, io) {
			const { values } = parseCommandArgs(args, taskOption);
			const project = requireProject(io);
			const record = openRecord(project, taskId(project, values.task));
			const text = await io.stdin();
			const modules = project.file?.modules ?? [];
			const close = text.trim() ? parseParts(text, (m) => modules.includes(m), 'the Task close') : undefined;
			const path = writeRecord(project.root, { ...record, header: { ...record.header, status: 'closed', closed: today() }, close });
			io.out(`Task ${record.id} closed: ${path}`);
			report(await raise({ name: 'task.close', task: record.id, record: path }, project, io, adapters, registry), io);
			return 0;
		},
		async show(args, io) {
			const { values } = parseCommandArgs(args, { ...taskOption, handoff: { type: 'boolean' } });
			const project = requireProject(io);
			const id = taskId(project, values.task);
			const record = readRecord(project.root, id);
			if (!record) throw new KalfaError(`no Task Record '${id}'`);
			io.out(values.handoff ? handoffView(record) : `${record.path}\n\n${readFileSync(record.path, 'utf8').trimEnd()}`);
			return 0;
		},
		async list(args, io) {
			parseCommandArgs(args, {});
			const records = listRecords(requireProject(io).root);
			if (!records.length) io.out('no Task Records');
			for (const r of records) io.out(`${r.id}  ${r.header.status}  ${r.sections.length} Section(s)  ${r.header.goal}`);
			return 0;
		},
	};

	return {
		summary: 'Start, close, show or list the Task Records of this repository',
		usage: 'kalfa task start "<goal>" [--plan <path>] [--task <id>]\n       kalfa task close [--task <id>]   (optional closing parts on stdin)\n       kalfa task show [--handoff] [--task <id>]\n       kalfa task list',
		async run(args, io) {
			const [sub, ...rest] = args;
			const run = sub && Object.hasOwn(subcommands, sub) ? subcommands[sub] : undefined;
			if (!run) throw new UsageError(sub ? `unknown subcommand '${sub}'` : 'give a subcommand');
			return run(rest, io);
		},
	};
}

export function sectionCommand(adapters: ReadonlyMap<string, Adapter>, registry: ReadonlyMap<string, ModuleDefinition>): Command {
	return {
		summary: 'Record a closed Section in the Task Record (its parts as Markdown on stdin)',
		usage: 'kalfa section close "<title>" [--task <id>] <<\'EOF\'\n**Done:** …\n**Found:** …\n**Next:** …\nEOF',
		async run(args, io) {
			const [sub, ...rest] = args;
			if (sub !== 'close') throw new UsageError(sub ? `unknown subcommand '${sub}'` : 'give a subcommand');
			const { values, positionals } = parseCommandArgs(rest, taskOption, true);
			const title = positionals.join(' ').trim();
			if (!title) throw new UsageError('give the Section title');
			const project = requireProject(io);
			const record = openRecord(project, taskId(project, values.task));
			const section = { title, parts: sectionParts(await io.stdin(), project.file?.modules ?? []) };
			const path = writeRecord(project.root, { ...record, sections: [...record.sections, section] });
			io.out(`Section "${title}" recorded in ${path}`);
			report(await raise({ name: 'section.close', task: record.id, record: path, section }, project, io, adapters, registry), io);
			return 0;
		},
	};
}
