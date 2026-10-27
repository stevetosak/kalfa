// `kalfa docs draft`: the Log's first draft from the Task Record (draft.ts).
// `kalfa docs check`: the Definition of Done gate on demand, before the PR.
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import picomatch from 'picomatch';
import { type Command, parseCommandArgs, UsageError } from '../../src/cli/command.ts';
import { taskId } from '../../src/cli/commands/task.ts';
import { requireModule, requireProject } from '../../src/cli/project.ts';
import { KalfaError } from '../../src/core/errors.ts';
import { readRecord } from '../../src/core/task-record.ts';
import { logDraft, logFileIn } from './draft.ts';
import { checkBranch, defaultBranch } from './gate.ts';
import { docsSettings, HOW_TO_PASS } from './handlers.ts';

const isDir = (path: string) => path.endsWith('/') || (existsSync(path) && statSync(path).isDirectory());

export function docsCommand(today = () => new Date().toISOString().slice(0, 10)): Command {
	return {
		summary: 'docs Module: draft the Log from the Task Record, and check the Definition of Done before a PR',
		usage: 'kalfa docs draft [--task <id>] [--out <dir or file>]   (without --out: print the draft)\n       kalfa docs check [--base <branch>] [--head <branch>]   (exit 1: no Log on the branch)',
		async run(args, io) {
			const [sub, ...rest] = args;
			const project = requireProject(io);
			if (sub === 'draft') {
				const { values } = parseCommandArgs(rest, { task: { type: 'string' }, out: { type: 'string' } });
				requireModule(project, 'docs');
				const id = taskId(project, values.task);
				const record = readRecord(project.root, id);
				if (!record) throw new KalfaError(`no Task Record '${id}'; start one with: kalfa task start "<goal>"`);
				const draft = logDraft(record, today());
				if (!values.out) {
					io.out(draft.trimEnd());
					return 0;
				}
				const out = resolve(io.cwd, values.out);
				const file = isDir(out) ? logFileIn(out, record, today()) : out;
				if (existsSync(file)) throw new KalfaError(`${file} exists; kalfa docs draft does not overwrite a page`);
				mkdirSync(dirname(file), { recursive: true });
				writeFileSync(file, draft);
				io.out(`Drafted the Log of Task ${record.id}: ${file}`);
				const { logs } = docsSettings(project);
				if (!picomatch(logs)(relative(project.root, file))) io.err(`kalfa docs: ${file} is not under ${logs.join(', ')}, so the gate does not count it as a Log.`);
				return 0;
			}
			if (sub === 'check') {
				const { values } = parseCommandArgs(rest, { base: { type: 'string' }, head: { type: 'string' } });
				requireModule(project, 'docs');
				const { logs, base } = docsSettings(project);
				const verdict = checkBranch({ dir: io.cwd, logGlobs: logs, base: values.base ?? base ?? defaultBranch(io.cwd), head: values.head });
				if (verdict.ok) {
					io.out(`Definition of Done met (${verdict.range}): Log ${verdict.logs.join(', ')}.`);
					return 0;
				}
				io.err(`Definition of Done not met (${verdict.range}): ${verdict.problem}. ${HOW_TO_PASS}`);
				return 1;
			}
			throw new UsageError(sub ? `unknown subcommand '${sub}'` : 'give a subcommand');
		},
	};
}
