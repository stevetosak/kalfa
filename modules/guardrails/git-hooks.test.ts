import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { packageRoot } from '../../src/core/package-root.ts';
import { tempDir } from '../../test/helpers.ts';
import { GIT_HOOK_NAMES, gitHooksDir, gitHooksEnv, gitHooksStep, RUNNER } from './git-hooks.ts';

const KALFA = join(packageRoot(), 'src', 'cli', 'bin.ts');
const context = (env: NodeJS.ProcessEnv, dryRun = false) => ({ env, moduleDir: '/modules/guardrails', dryRun });

test('the step writes the runner and one wrapper per hook name, reports a dry run, and removes only its own folder', () => {
	const env = { HOME: tempDir() };
	const dir = gitHooksDir(env);
	const step = gitHooksStep({ kalfa: KALFA, version: () => [2, 34] });

	assert.match(step.install(context(env, true)).join('\n'), /^git hooks: write 28 file\(s\) in .*git-hooks/);
	assert.equal(existsSync(dir), false, 'a dry run writes nothing');
	step.install(context(env));
	assert.deepEqual(readdirSync(dir).sort(), [RUNNER, ...GIT_HOOK_NAMES].sort());
	for (const name of readdirSync(dir)) assert.equal(statSync(join(dir, name)).mode & 0o111, 0o111, name);
	assert.match(readFileSync(join(dir, 'pre-push'), 'utf8'), /exec "\$\(dirname "\$0"\)\/_kalfa-run" pre-push "\$@"/);
	assert.deepEqual(step.install(context(env)), [`git hooks: ${dir}; nothing to change`]);

	writeFileSync(join(dir, 'old-hook'), 'x');
	assert.match(step.install(context(env)).join('\n'), /write 0 file\(s\), remove 1/);
	assert.equal(existsSync(join(dir, 'old-hook')), false);

	assert.deepEqual(step.agentEnv!(context(env)), { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: dir });
	assert.deepEqual(step.uninstall(context(env, true)), [`git hooks: remove ${dir}`]);
	assert.ok(existsSync(dir), 'a dry run removes nothing');
	step.uninstall(context(env));
	assert.equal(existsSync(dir), false);
	assert.deepEqual(step.uninstall(context(env)), ['git hooks: none; nothing to change']);

	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, 'pre-push'), '#!/bin/sh\n');
	assert.match(step.install(context(env)).join('\n'), /is not kalfa's; left as it is/);
	assert.match(step.uninstall(context(env)).join('\n'), /is not kalfa's; left as it is/);
	assert.ok(existsSync(join(dir, 'pre-push')));
});

test('the step reports a git that reads no config from the environment, or no git', () => {
	const env = { HOME: tempDir() };
	assert.match(gitHooksStep({ kalfa: KALFA, version: () => [2, 30] }).install(context(env, true)).join('\n'), /git 2\.30 reads no config from the environment/);
	assert.match(gitHooksStep({ kalfa: KALFA, version: () => undefined }).install(context(env, true)).join('\n'), /git does not answer/);
	assert.doesNotMatch(gitHooksStep({ kalfa: KALFA, version: () => [3, 0] }).install(context(env, true)).join('\n'), /problem/);
});

/** A repository with one commit, a bare remote, and the hooks folder installed; `git` runs as the agent's git. */
function agentRepo() {
	const at = tempDir();
	const env = { HOME: at, XDG_CONFIG_HOME: join(at, 'config'), PATH: process.env.PATH, KALFA_NODE: process.execPath, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
	gitHooksStep({ kalfa: KALFA }).install(context(env));
	const agent = { ...env, ...gitHooksEnv(gitHooksDir(env)) };
	const work = join(at, 'work');
	execFileSync('git', ['init', '-q', '--bare', join(at, 'remote')], { env });
	execFileSync('git', ['init', '-q', '-b', 'main', work], { env });
	execFileSync('git', ['-C', work, 'commit', '-q', '--allow-empty', '-m', 'x'], { env });
	execFileSync('git', ['-C', work, 'remote', 'add', 'origin', join(at, 'remote')], { env });
	/** Runs a shell command line in the work tree as the agent (or as the Operator, without the hooks folder). */
	const sh = (line: string, as: NodeJS.ProcessEnv = agent) => spawnSync('sh', ['-c', line], { cwd: work, env: as, encoding: 'utf8' });
	/** Writes the repository's own hook `name` into `folder` (relative to the work tree); it logs its name, arguments and input and exits with `status`. */
	const ownHook = (folder: string, name: string, status = 0) => {
		mkdirSync(join(work, folder), { recursive: true });
		writeFileSync(join(work, folder, name), `#!/bin/sh\n{ echo "${name} $*"; cat; } >> "${join(at, 'own.log')}"\nexit ${status}\n`, { mode: 0o755 });
	};
	const ownLog = () => (existsSync(join(at, 'own.log')) ? readFileSync(join(at, 'own.log'), 'utf8') : '');
	return { at, env, agent, work, sh, ownHook, ownLog };
}

test("a push from the agent to a protected branch is refused by the pre-push hook, whatever the command line looks like", () => {
	const { sh, work, at, env } = agentRepo();
	writeFileSync(join(at, 'push.sh'), 'cd "$1" && git push -q origin HEAD:main\n');
	for (const line of [
		'git push -q origin main',
		'git push -q origin HEAD:refs/heads/main',
		'true\ngit push -q origin main',
		"sh <<'EOF'\ngit push -q origin main\nEOF",
		`sh ${join(at, 'push.sh')} ${work}`,
		'b=main; git push -q origin "$b"',
	]) {
		const out = sh(line);
		assert.notEqual(out.status, 0, line);
		assert.match(out.stderr, /kalfa guardrails refused a push to the protected branch 'main' \(remote origin\)/, line);
	}
	assert.equal(sh('git push -q origin main:feat/x').status, 0);
	assert.equal(sh('git push -q origin main', env).status, 0, 'the Operator pushes main');
	assert.match(sh('git push -q origin :main').stderr, /refused a delete of the protected branch 'main'/);
	assert.match(sh('git push -q --delete origin main').stderr, /refused a delete of the protected branch 'main'/);
});

test("the repository's own hooks still run: the common git folder's hooks, core.hooksPath, a worktree", () => {
	const { sh, ownHook, ownLog, work, at, agent } = agentRepo();
	ownHook('.git/hooks', 'pre-push');
	assert.equal(sh('git push -q origin main:feat/a').status, 0);
	assert.match(ownLog(), /^pre-push origin .*remote\nrefs\/heads\/main [0-9a-f]{40} refs\/heads\/feat\/a 0{40}\n$/, 'the same arguments and input');

	assert.notEqual(sh('git push -q origin main').status, 0);
	assert.equal(ownLog().match(/^pre-push/gm)?.length, 1, "a refused push does not run the repository's pre-push hook");

	ownHook('.githooks', 'pre-commit', 1);
	sh('git config core.hooksPath .githooks');
	assert.notEqual(sh('git commit -q --allow-empty -m y').status, 0, "the repository's failing pre-commit hook stops the agent's commit");
	assert.match(ownLog(), /^pre-commit/m);

	sh('git config --unset core.hooksPath');
	execFileSync('git', ['-C', work, 'worktree', 'add', '-q', '-b', 'feat/w', join(at, 'wt')], { env: agent });
	const fromWorktree = spawnSync('git', ['push', '-q', 'origin', 'feat/w'], { cwd: join(at, 'wt'), env: agent, encoding: 'utf8' });
	assert.equal(fromWorktree.status, 0, fromWorktree.stderr);
	assert.match(ownLog(), /refs\/heads\/feat\/w/, "a worktree runs the common git folder's hooks");
});

test("only the agent's git is checked; a kalfa that cannot run refuses the push; kalfa's folder as the repository's own runs once", () => {
	const { sh, env, agent } = agentRepo();
	assert.equal(sh('git push -q origin main', env).status, 0, "the Operator's own push is not checked");

	const broken = sh('git push -q origin main:feat/b', { ...agent, KALFA_NODE: '/nonexistent/node' });
	assert.notEqual(broken.status, 0);
	assert.match(broken.stderr, /the push check could not run \(exit 127\), so the push is refused/);

	sh(`git config core.hooksPath ${gitHooksDir(env)}`, env);
	assert.equal(sh('git push -q origin main:feat/c').status, 0);
	assert.notEqual(sh('git push -q origin main:master').status, 0);
});
