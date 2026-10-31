// `kalfa doctor --smoke`: the clean-state smoke. It installs this kalfa into a
// throw-away HOME, uses it on a throw-away repository the way an Operator and a
// harness would, then takes it away again and checks that nothing is left.
// Every kalfa call is a new process that runs the built files through the
// links, so the smoke proves the bundle and the shim, not the source. Nothing
// outside the smoke folder changes; on a failure the folder is kept for a look.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, relative } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { parse, stringify } from 'yaml';
import { KalfaError } from '../core/errors.ts';
import type { Io } from './io.ts';
import { LINKED } from './commands/link.ts';
import { version } from './version.ts';

const SETTINGS = '.claude/settings.local.json';
const PLAN_TITLE = 'Smoke plan';
const GOAL = 'smoke goal';

/** The Operator's own settings: an approval and a hook that kalfa must keep. */
/** The session report's summary line (src/modules/core.ts). */
const SUMMARY = /^kalfa: (\d+ open Plans?|Task \S+ open|\d+ (other )?open Tasks?|continuing Task)/;

const OPERATOR_SETTINGS = {
	permissions: { allow: ['Bash(git status)'] },
	hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'operator-own-hook' }] }] },
};

const SMOKE_MODULE: Record<string, string> = {
	'smoke/module.yaml': "schema: 1\ndescription: The smoke test's Module.\ncommands:\n  allow: ['smoke-check *']\n",
	'smoke/skills/smoke-skill/SKILL.md': '---\nname: smoke-skill\ndescription: The smoke test skill.\n---\nBody.\n',
	'smoke/rules/always.md': 'A rule from the smoke Module.\n',
};

const REPO_FILES: Record<string, string> = {
	'.gitignore': '.claude/\n',
	'AGENTS.md': '# Agents\n',
	'CLAUDE.md': 'Claude-only line.\n',
	'docs/plan.md': `---\ntype: plan\ntitle: ${PLAN_TITLE}\nstatus: active\n---\n- [ ] the first step\n`,
	[SETTINGS]: `${JSON.stringify(OPERATOR_SETTINGS)}\n`,
};

interface World {
	packageRoot: string;
	root: string;
	home: string;
	bin: string;
	repo: string;
	env: NodeJS.ProcessEnv;
	/** The repository's files right after `kalfa init`, outside `.git/` and `.kalfa/`. */
	afterInit?: Map<string, string>;
}

class SmokeFailure extends Error {}

function expect(ok: unknown, what: string): asserts ok {
	if (!ok) throw new SmokeFailure(what);
}

function writeFiles(dir: string, files: Record<string, string>): void {
	for (const [path, text] of Object.entries(files)) {
		mkdirSync(dirname(join(dir, path)), { recursive: true });
		writeFileSync(join(dir, path), text);
	}
}

/** Path → sha256 of every file under `dir` (a folder counts too), without the top-level entries in `skip`. */
function snapshot(dir: string, skip: string[] = []): Map<string, string> {
	const files = new Map<string, string>();
	const walk = (at: string) => {
		for (const entry of readdirSync(at, { withFileTypes: true })) {
			const path = join(at, entry.name);
			if (skip.includes(relative(dir, path))) continue;
			if (entry.isDirectory()) {
				files.set(relative(dir, path), 'folder');
				walk(path);
			} else files.set(relative(dir, path), createHash('sha256').update(readFileSync(path)).digest('hex'));
		}
	};
	walk(dir);
	return files;
}

function differences(before: Map<string, string>, after: Map<string, string>): string[] {
	const paths = new Set([...before.keys(), ...after.keys()]);
	return [...paths].sort().filter((path) => before.get(path) !== after.get(path)).map((path) => (!after.has(path) ? `${path} is gone` : !before.has(path) ? `${path} is new` : `${path} changed`));
}

interface Ran {
	status: number | null;
	stdout: string;
	stderr: string;
}

function exec(world: World, command: string, args: string[], options: { cwd?: string; input?: string; env?: NodeJS.ProcessEnv } = {}): Ran {
	const out = spawnSync(command, args, { cwd: options.cwd ?? world.repo, input: options.input ?? '', env: { ...world.env, ...options.env }, encoding: 'utf8' });
	if (out.error) throw new SmokeFailure(`${command} did not start: ${out.error.message}`);
	return { status: out.status, stdout: out.stdout, stderr: out.stderr };
}

/** Runs the linked `kalfa` from PATH and expects success; returns its stdout. */
function kalfa(world: World, args: string[], cwd?: string): string {
	const out = exec(world, 'kalfa', args, { cwd });
	expect(out.status === 0, `kalfa ${args.join(' ')} exited ${out.status}: ${out.stderr.trim()}`);
	return out.stdout;
}

const read = (world: World, path: string) => readFileSync(join(world.repo, path), 'utf8');

function hookPayload(world: World, hook: string, extra: Record<string, unknown>): string {
	return JSON.stringify({ session_id: '00000000-0000-4000-8000-000000000000', transcript_path: join(world.home, 'transcript.jsonl'), cwd: world.repo, hook_event_name: hook, ...extra });
}

const steps: Array<{ name: string; run: (world: World) => void }> = [
	{
		name: 'install: kalfa link puts kalfa and kalfa-hook on PATH',
		run(world) {
			const linked = exec(world, process.execPath, [join(world.packageRoot, 'dist', LINKED.kalfa), 'link'], { cwd: world.home });
			expect(linked.status === 0, `kalfa link exited ${linked.status}: ${linked.stderr.trim()}`);
			expect(kalfa(world, ['--version'], world.home).trim() === version, 'kalfa on PATH is not this version');
			expect(kalfa(world, ['doctor'], world.home).includes(`install: linked to this checkout (${join(world.bin, 'kalfa')})`), 'kalfa doctor does not see the link');
		},
	},
	{
		name: 'the private folder is refused until git ignores it',
		run(world) {
			const out = exec(world, 'kalfa', ['task', 'start', GOAL]);
			expect(out.status === 1 && out.stderr.includes('git does not ignore it'), `kalfa task start was not refused: ${out.stderr.trim()}`);
			expect(!existsSync(join(world.repo, '.kalfa')), '.kalfa/ was created');
		},
	},
	{
		name: 'init writes kalfa.yaml, the .kalfa/ ignore and the AGENTS.md import',
		run(world) {
			kalfa(world, ['init', '--module', 'smoke']);
			expect(isDeepStrictEqual(parse(read(world, 'kalfa.yaml')), { schema: 1, modules: ['smoke'], plans: ['docs/**/*.md'] }), 'kalfa.yaml is not as expected');
			expect(read(world, '.gitignore').split('\n').includes('.kalfa/'), '.gitignore does not ignore .kalfa/');
			expect(read(world, 'CLAUDE.md').startsWith('@AGENTS.md\n'), 'CLAUDE.md does not import AGENTS.md');
			kalfa(world, ['task', 'start', GOAL]);
			world.afterInit = snapshot(world.repo, ['.git', '.kalfa']);
		},
	},
	{
		name: "build writes the Module's files and keeps the Operator's settings",
		run(world) {
			kalfa(world, ['build']);
			expect(existsSync(join(world.repo, '.claude/skills/smoke-skill/SKILL.md')), 'the skill is not written');
			expect(existsSync(join(world.repo, '.claude/rules/kalfa-smoke-always.md')), 'the rule is not written');
			const settings = JSON.parse(read(world, SETTINGS));
			expect(isDeepStrictEqual(settings.hooks, OPERATOR_SETTINGS.hooks), "the Operator's hook is not kept");
			expect(isDeepStrictEqual(settings.permissions?.allow, ['Bash(git status)', 'Bash(smoke-check *)']), `the approvals are ${JSON.stringify(settings.permissions)}`);
			expect(kalfa(world, ['doctor']).includes('build: up to date'), 'kalfa doctor does not see the build as up to date');
		},
	},
	{
		name: 'hooks fire through kalfa-hook, and the fast path skips Node',
		run(world) {
			const start = exec(world, 'kalfa-hook', ['claude', 'session.start'], { input: hookPayload(world, 'SessionStart', { source: 'startup' }) });
			expect(start.status === 0, `session.start exited ${start.status}: ${start.stderr.trim()}`);
			const output = JSON.parse(start.stdout || '{}');
			// The one-line summary for the Operator is expected; any other notice is a fault.
			const faults = String(output.systemMessage ?? '').split('\n').filter((line) => line && !SUMMARY.test(line));
			expect(!faults.length, `session.start gave a notice: ${faults.join(' / ')}`);
			const context = String(output.hookSpecificOutput?.additionalContext ?? '');
			expect(context.includes(PLAN_TITLE) && context.includes(GOAL), 'the session report does not name the Plan and the Task');
			expect(existsSync(join(world.repo, '.kalfa/events')), 'session.start did not write the event table');
			// No Module handles command.before, so the shim must answer without Node.
			const noNode = { KALFA_NODE: join(world.root, 'no-node') };
			const before = exec(world, 'kalfa-hook', ['claude', 'command.before'], { input: hookPayload(world, 'PreToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' } }), env: noNode });
			expect(before.status === 0 && before.stdout === '', `command.before started Node (exit ${before.status}: ${before.stderr.trim()})`);
		},
	},
	{
		name: 'uninstall: no Modules, then kalfa unlink, leave nothing behind',
		run(world) {
			const project = parse(read(world, 'kalfa.yaml'));
			writeFileSync(join(world.repo, 'kalfa.yaml'), stringify({ ...project, modules: [] }));
			kalfa(world, ['build']);
			// kalfa rewrites the settings file with its own JSON layout; compare its content.
			expect(isDeepStrictEqual(JSON.parse(read(world, SETTINGS)), OPERATOR_SETTINGS), "the settings file is not the Operator's own again");
			const left = differences(world.afterInit!, snapshot(world.repo, ['.git', '.kalfa'])).filter((d) => d !== `${SETTINGS} changed` && d !== 'kalfa.yaml changed');
			expect(!left.length, `the repository differs from right after init: ${left.join('; ')}`);
			kalfa(world, ['unlink'], world.home);
			// The bin folder is the user's own place for programs; kalfa leaves it, empty.
			const home = [...snapshot(world.home).keys()].filter((path) => path !== '.local' && path !== relative(world.home, world.bin));
			expect(!home.length, `left in HOME: ${home.join(', ')}`);
		},
	},
];

/** PATH without the folders that hold another kalfa, so only the smoke's install answers. */
function cleanPath(path: string | undefined): string[] {
	return (path ?? '').split(delimiter).filter((dir) => dir && !Object.keys(LINKED).some((name) => existsSync(join(dir, name))));
}

function setUp(packageRoot: string): World {
	const root = mkdtempSync(join(tmpdir(), 'kalfa-smoke-'));
	const home = join(root, 'home');
	const repo = join(root, 'repo');
	const modules = join(root, 'modules');
	const bin = join(home, '.local', 'bin');
	mkdirSync(home);
	writeFiles(modules, SMOKE_MODULE);
	writeFiles(repo, REPO_FILES);
	const env: NodeJS.ProcessEnv = { HOME: home, PATH: [bin, dirname(process.execPath), ...cleanPath(process.env.PATH)].join(delimiter), KALFA_MODULES_DIR: modules, GIT_CONFIG_NOSYSTEM: '1' };
	if (process.env.TMPDIR) env.TMPDIR = process.env.TMPDIR;
	const world: World = { packageRoot, root, home, bin, repo, env };
	const init = exec(world, 'git', ['init', '-q', repo], { cwd: root });
	expect(init.status === 0, `git init failed: ${init.stderr.trim()}`);
	return world;
}

export function runSmoke(packageRoot: string, io: Io): number {
	for (const file of Object.values(LINKED)) {
		if (!existsSync(join(packageRoot, 'dist', file))) throw new KalfaError(`${join(packageRoot, 'dist', file)} does not exist; run npm run build`);
	}
	const world = setUp(packageRoot);
	io.out(`smoke: kalfa ${version} from ${packageRoot}, in ${world.root}`);
	for (const step of steps) {
		try {
			step.run(world);
			io.out(`ok    ${step.name}`);
		} catch (error) {
			io.out(`FAIL  ${step.name}: ${(error as Error).message}`);
			io.out(`smoke: failed; the smoke folder is kept: ${world.root}`);
			return 1;
		}
	}
	rmSync(world.root, { recursive: true, force: true });
	io.out(`smoke: all ${steps.length} steps passed`);
	io.out('not yet in the smoke: the harness hooks at user scope (Plan step 4 wires them)');
	return 0;
}
