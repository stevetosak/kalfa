// `kalfa init`: turns a repository into a kalfa project. It writes
// `kalfa.yaml`, makes git ignore `.kalfa/`, and imports `AGENTS.md` into each
// harness's own instruction file that would otherwise hide it. It changes
// committed files, so it prints each change, and --dry-run only prints.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stringify } from 'yaml';
import type { Adapter } from '../../adapters/adapter.ts';
import { KalfaError } from '../../core/errors.ts';
import type { ModuleDirs } from '../../core/module-dirs.ts';
import { loadModuleSource } from '../../core/module-source.ts';
import { findPlans } from '../../core/plans.ts';
import { isPrivateDirIgnored, PRIVATE_DIR } from '../../core/private-dir.ts';
import { AGENTS_FILE, PROJECT_FILE } from '../../core/project.ts';
import { type Command, parseCommandArgs } from '../command.ts';
import { requireProject } from '../project.ts';

const DEFAULT_PLANS = 'docs/**/*.md';

export function initCommand(adapters: ReadonlyMap<string, Adapter>, moduleDirs: ModuleDirs): Command {
	return {
		summary: 'Make this repository a kalfa project: kalfa.yaml, the .kalfa/ ignore, the AGENTS.md import',
		usage: 'kalfa init [--module <name>]... [--plans <glob>]... [--dry-run]',
		async run(args, io) {
			const { values } = parseCommandArgs(args, {
				module: { type: 'string', multiple: true },
				plans: { type: 'string', multiple: true },
				'dry-run': { type: 'boolean' },
			});
			const { root, file } = requireProject(io);
			if (file) throw new KalfaError(`${PROJECT_FILE} exists already; edit it, then run kalfa build`);
			const modules = values.module ?? [];
			for (const name of modules) loadModuleSource(moduleDirs(io.env), name);
			// Without --plans, the documentation folder counts when it holds a Plan.
			const plans = values.plans ?? (findPlans(root, [DEFAULT_PLANS]).plans.length ? [DEFAULT_PLANS] : []);

			const changes: Array<{ say: string; apply: () => void }> = [];
			const text = `${stringify({ schema: 1, modules, plans }, { flow: false }).trimEnd()}\n`;
			changes.push({ say: `write ${PROJECT_FILE} (commit it):\n${text.trimEnd().replace(/^/gm, '  ')}`, apply: () => writeFileSync(join(root, PROJECT_FILE), text) });

			if (!isPrivateDirIgnored(root)) {
				const ignore = join(root, '.gitignore');
				const lead = existsSync(ignore) && !readFileSync(ignore, 'utf8').endsWith('\n') ? '\n' : '';
				changes.push({ say: `add ${PRIVATE_DIR}/ to .gitignore (commit it)`, apply: () => appendFileSync(ignore, `${lead}${PRIVATE_DIR}/\n`) });
			}

			const hints: string[] = [];
			for (const adapter of adapters.values()) {
				const own = adapter.project?.instructions;
				if (!own || !existsSync(join(root, own.file))) continue;
				const current = readFileSync(join(root, own.file), 'utf8');
				if (current.split('\n').some((line) => line.trim() === own.importLine)) continue;
				if (existsSync(join(root, AGENTS_FILE))) {
					changes.push({ say: `import ${AGENTS_FILE} at the top of ${own.file} (commit it)`, apply: () => writeFileSync(join(root, own.file), `${own.importLine}\n\n${current}`) });
				} else {
					hints.push(`${own.file} holds this repository's instructions; move the part every harness needs to ${AGENTS_FILE} and import it with ${own.importLine}`);
				}
			}

			for (const change of changes) io.out(change.say);
			for (const hint of hints) io.out(`note: ${hint}`);
			if (values['dry-run']) {
				io.out('dry run: nothing was written');
				return 0;
			}
			for (const change of changes) change.apply();
			io.out(modules.length ? 'next: kalfa build' : `next: name Modules in ${PROJECT_FILE}, then kalfa build`);
			return 0;
		},
	};
}
