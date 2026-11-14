// Fixtures of the herdr Module's space tests: a repository with an origin, a
// fake herdr, and machine settings with a herdr part.
import { execFileSync } from 'node:child_process';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gitRepo, tempDir } from './helpers.ts';

export const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { stdio: 'ignore' });

/** `<dir>/origin.git` and its clone `<dir>/proj` (main checkout), with kalfa.yaml, the .kalfa/ ignore and `files`. */
export function cloned(files: Record<string, string> = {}) {
	const all = { 'kalfa.yaml': 'schema: 1\n', '.gitignore': '.kalfa/\n', ...files };
	const seed = realpathSync(gitRepo(all));
	git(seed, 'add', ...Object.keys(all));
	git(seed, 'commit', '-q', '-m', 'init');
	const dir = realpathSync(tempDir());
	execFileSync('git', ['clone', '-q', '--bare', seed, join(dir, 'origin.git')]);
	execFileSync('git', ['clone', '-q', join(dir, 'origin.git'), join(dir, 'proj')]);
	return { dir, main: join(dir, 'proj'), origin: join(dir, 'origin.git') };
}

/** A fake herdr: records each call and answers like Herdr 0.9. */
export function fakeHerdr(workspaces: { workspace_id: string; label: string }[] = []) {
	const calls: string[][] = [];
	let n = 0;
	const exec = (args: string[]) => {
		calls.push(args);
		const key = args.slice(0, 2).join(' ');
		if (key === 'workspace list') return JSON.stringify({ result: { workspaces } });
		if (key === 'agent list') return JSON.stringify({ result: { agents: [] } });
		if (key === 'tab create') return JSON.stringify({ result: { tab: { tab_id: `t${++n}` }, root_pane: { pane_id: `p${n}` } } });
		if (key === 'workspace create') return JSON.stringify({ result: { workspace: { workspace_id: 'w9' }, tab: { tab_id: `t${++n}` }, root_pane: { pane_id: `p${n}` } } });
		return '{}';
	};
	return { exec, calls };
}

export function machine(herdr: unknown) {
	const config = tempDir();
	mkdirSync(join(config, 'kalfa'), { recursive: true });
	writeFileSync(join(config, 'kalfa/config.yaml'), JSON.stringify({ schema: 1, modules: ['herdr'], settings: { herdr } }));
	return { HOME: tempDir(), XDG_CONFIG_HOME: config };
}
