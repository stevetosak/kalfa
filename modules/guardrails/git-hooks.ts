// The guardrails Module's part of `kalfa install`: a git hooks folder for the
// agent's git only. The step writes the folder in the machine data folder and
// asks for three entries in the environment of the agent's commands, which set
// `core.hooksPath` to it (git 2.31 and later read config from the environment).
// No repository file changes, and the Operator's own git does not see it.
//
// Each hook name has a wrapper that runs the repository's own hook of that
// name, so every hook the repository has still runs. The repository's hooks
// folder is read with kalfa's entries left out: its `core.hooksPath`, else the
// `hooks` folder of the common git folder (shared by every worktree). The
// pre-push wrapper first runs `kalfa guardrails pre-push`, which refuses a
// push to a protected branch; when kalfa cannot run, the push is refused.
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { quote } from 'shell-quote';
import type { MachineStep } from '../../src/core/machine-step.ts';
import { machineDataDir } from '../../src/core/machine-paths.ts';
import { packageRoot } from '../../src/core/package-root.ts';

/** The hook names git runs from the hooks folder (githooks(5), git 2.34); `fsmonitor-watchman` is set by `core.fsmonitor`, not found here. */
export const GIT_HOOK_NAMES = [
	'applypatch-msg',
	'pre-applypatch',
	'post-applypatch',
	'pre-commit',
	'pre-merge-commit',
	'prepare-commit-msg',
	'commit-msg',
	'post-commit',
	'pre-rebase',
	'post-checkout',
	'post-merge',
	'pre-push',
	'pre-receive',
	'update',
	'proc-receive',
	'post-receive',
	'post-update',
	'reference-transaction',
	'push-to-checkout',
	'pre-auto-gc',
	'post-rewrite',
	'sendemail-validate',
	'post-index-change',
	'p4-changelist',
	'p4-prepare-changelist',
	'p4-post-changelist',
	'p4-pre-submit',
] as const;

/** The script every wrapper runs; its first lines mark the folder as kalfa's. */
export const RUNNER = '_kalfa-run';
const MARK = '# kalfa: the git hooks of the agent (kalfa install writes this folder, kalfa uninstall removes it).';

/** git reads config from the environment from this version on. */
const GIT_ENV_CONFIG = [2, 31] as const;

/** The folder of the agent's git hooks on this machine. */
export const gitHooksDir = (env: NodeJS.ProcessEnv) => join(machineDataDir(env), 'git-hooks');

/** The entries in the agent's environment that point git at `dir`. */
export const gitHooksEnv = (dir: string): Record<string, string> => ({
	GIT_CONFIG_COUNT: '1',
	GIT_CONFIG_KEY_0: 'core.hooksPath',
	GIT_CONFIG_VALUE_0: dir,
});

/** The runner: the repository's own hook, after kalfa's push check for pre-push. `kalfa` is the bundle's path. */
export function runnerScript(kalfa: string): string {
	return `#!/bin/sh
${MARK}
# Runs the repository's own hook named $1 with the rest of the arguments and the
# input; for pre-push, kalfa's push check runs first and a refusal stops the push.
name=$1
shift
here=$(cd "$(dirname "$0")" && pwd -P)
own_dir=$(GIT_CONFIG_COUNT=0 git config --type=path core.hooksPath)
[ -n "$own_dir" ] || own_dir="$(git rev-parse --git-common-dir)/hooks"
own="$own_dir/$name"
# kalfa's own folder as the repository's hooks path would run this script again.
if [ -d "$own_dir" ] && [ "$(cd "$own_dir" && pwd -P)" = "$here" ]; then own=; fi
runs_own() { [ -n "$own" ] && [ -f "$own" ] && [ -x "$own" ]; }
if [ "$name" = pre-push ]; then
	input=$(cat)
	{ [ -z "$input" ] || printf '%s\\n' "$input"; } | "\${KALFA_NODE:-node}" ${quote([kalfa])} guardrails pre-push "$@"
	status=$?
	if [ "$status" -ne 0 ]; then
		[ "$status" -eq 1 ] || echo "kalfa guardrails: the push check could not run (exit $status), so the push is refused" >&2
		exit 1
	fi
	runs_own || exit 0
	{ [ -z "$input" ] || printf '%s\\n' "$input"; } | "$own" "$@"
	exit $?
fi
runs_own || exit 0
exec "$own" "$@"
`;
}

const wrapperScript = (name: string) => `#!/bin/sh\n${MARK}\nexec "$(dirname "$0")/${RUNNER}" ${name} "$@"\n`;

/** The folder's files, by name. */
export function gitHooksFiles(kalfa: string): Map<string, string> {
	return new Map([[RUNNER, runnerScript(kalfa)], ...GIT_HOOK_NAMES.map((name) => [name, wrapperScript(name)] as const)]);
}

const isKalfas = (dir: string) => existsSync(join(dir, RUNNER)) && readFileSync(join(dir, RUNNER), 'utf8').includes(MARK);

/** The git version, as numbers; `undefined` when git does not answer. */
export type GitVersion = () => readonly number[] | undefined;

const gitVersion: GitVersion = () => {
	const out = spawnSync('git', ['--version'], { encoding: 'utf8' });
	const match = out.status === 0 ? /(\d+)\.(\d+)/.exec(out.stdout) : null;
	return match ? [Number(match[1]), Number(match[2])] : undefined;
};

function versionLine(version: GitVersion): string[] {
	const found = version();
	if (!found) return ['git hooks: problem: git does not answer, so the push check cannot run'];
	const [major = 0, minor = 0] = found;
	const old = major < GIT_ENV_CONFIG[0] || (major === GIT_ENV_CONFIG[0] && minor < GIT_ENV_CONFIG[1]);
	return old ? [`git hooks: problem: git ${found.join('.')} reads no config from the environment (${GIT_ENV_CONFIG.join('.')} and later), so the push check does not run`] : [];
}

export interface GitHooksOptions {
	/** The bundle the pre-push check runs. */
	kalfa?: string;
	version?: GitVersion;
}

export function gitHooksStep({ kalfa = join(packageRoot(), 'dist', 'kalfa.mjs'), version = gitVersion }: GitHooksOptions = {}): MachineStep {
	return {
		agentEnv: ({ env }) => gitHooksEnv(gitHooksDir(env)),
		install: ({ env, dryRun }) => {
			const dir = gitHooksDir(env);
			if (existsSync(dir) && readdirSync(dir).length && !isKalfas(dir)) return [`git hooks: ${dir} is not kalfa's; left as it is, and the push check does not run`];
			const files = gitHooksFiles(kalfa);
			const stale = existsSync(dir) ? readdirSync(dir).filter((name) => !files.has(name)) : [];
			const changed = [...files].filter(([name, text]) => !existsSync(join(dir, name)) || readFileSync(join(dir, name), 'utf8') !== text);
			const lines = versionLine(version);
			if (!changed.length && !stale.length) return [`git hooks: ${dir}; nothing to change`, ...lines];
			if (!dryRun) {
				mkdirSync(dir, { recursive: true });
				for (const name of stale) rmSync(join(dir, name), { recursive: true, force: true });
				for (const [name, text] of changed) {
					writeFileSync(join(dir, name), text);
					chmodSync(join(dir, name), 0o755);
				}
			}
			return [`git hooks: write ${changed.length} file(s)${stale.length ? `, remove ${stale.length}` : ''} in ${dir} (the agent's git runs the repository's hooks through them; pre-push checks the protected branches first)`, ...lines];
		},
		uninstall: ({ env, dryRun }) => {
			const dir = gitHooksDir(env);
			if (!existsSync(dir)) return ['git hooks: none; nothing to change'];
			if (!isKalfas(dir)) return [`git hooks: ${dir} is not kalfa's; left as it is`];
			if (!dryRun) rmSync(dir, { recursive: true, force: true });
			return [`git hooks: remove ${dir}`];
		},
	};
}
