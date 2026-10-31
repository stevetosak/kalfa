// `kalfa doctor --smoke`: the clean-state smoke. It installs this kalfa into a
// throw-away HOME, uses it on a throw-away repository the way an Operator and a
// harness would, then takes it away again and checks that nothing is left.
// Every kalfa call is a new process that runs the built files through the
// links, so the smoke proves the bundle and the shim, not the source. Nothing
// outside the smoke folder changes; on a failure the folder is kept for a look.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
const PERSONAL_RULE = 'Smoke personal rule.';
const PROJECT_FACT = 'Smoke project fact.';
/** The Memory home kalfa memory creates, the Operator's data: kalfa uninstall keeps it. */
const MEMORY_HOME = '.local/share/kalfa/memory';
const CANDIDATE = 'Smoke candidate from the Task.';
const ACCEPTED = 'Smoke accepted candidate.';
const GOAL = 'smoke goal';

/** The Operator's own settings: an approval and a hook that kalfa must keep. */
/** The session report's summary line (src/modules/core.ts). */
const SUMMARY = /^kalfa: (memory: \d+ rules?|\d+ open Plans?|Task \S+ open|\d+ (other )?open Tasks?|continuing Task)/;

const OPERATOR_SETTINGS = {
	permissions: { allow: ['Bash(git status)'] },
	hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'operator-own-hook' }] }] },
};

/** The Operator's own user settings: a hook of another tool, a status line and a key that kalfa install must keep. */
const USER_SETTINGS = '.claude/settings.json';
const OPERATOR_USER_SETTINGS = {
	model: 'smoke-model',
	statusLine: { type: 'command', command: 'operator-status-line --short' },
	hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'other-tool-hook' }] }] },
};

const HOME_FILES: Record<string, string> = {
	[USER_SETTINGS]: `${JSON.stringify(OPERATOR_USER_SETTINGS)}\n`,
	// The machine's own Modules: their approvals go into the user settings.
	'.config/kalfa/config.yaml': 'schema: 1\nmodules: [smoke]\n',
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
	/** HOME's files before kalfa ran. */
	homeBefore?: Map<string, string>;
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
const userSettings = (world: World) => JSON.parse(readFileSync(join(world.home, USER_SETTINGS), 'utf8'));

/** The command kalfa install wrote for `hook`. */
function installedHook(world: World, hook: string): string {
	const groups: Array<{ hooks: Array<{ command: string }> }> = userSettings(world).hooks?.[hook] ?? [];
	const command = groups.flatMap((group) => group.hooks.map((h) => h.command)).find((c) => c.includes('kalfa-hook'));
	expect(command, `kalfa install wrote no ${hook} hook`);
	return command;
}

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
		name: "install: kalfa install writes its hooks, the status-line tap and the approvals next to the Operator's own",
		run(world) {
			kalfa(world, ['install'], world.home);
			const settings = userSettings(world);
			expect(settings.model === OPERATOR_USER_SETTINGS.model, 'the Operator key is not kept');
			expect(settings.hooks.SessionStart[0].hooks[0].command === 'other-tool-hook', "the other tool's hook is not kept first");
			for (const hook of ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse']) installedHook(world, hook);
			expect(/status-tap operator-status-line --short$/.test(settings.statusLine.command), `the status line is ${settings.statusLine.command}`);
			expect(isDeepStrictEqual(settings.permissions, { allow: ['Bash(smoke-check *)'] }), `the user approvals are ${JSON.stringify(settings.permissions)}`);
			expect(kalfa(world, ['install'], world.home).includes('nothing to change'), 'a second kalfa install changed something');
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
			// The command that kalfa install wrote, run the way the harness runs it.
			const start = exec(world, 'sh', ['-c', installedHook(world, 'SessionStart')], { input: hookPayload(world, 'SessionStart', { source: 'startup' }) });
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
		name: 'memory: kalfa memory writes records in the Memory home, and session.start injects both layers',
		run(world) {
			kalfa(world, ['memory', 'add', '--type', 'rule', '--layer', 'personal', '--summary', PERSONAL_RULE]);
			kalfa(world, ['memory', 'add', '--type', 'fact', '--layer', 'project', '--summary', PROJECT_FACT]);
			const home = join(world.home, MEMORY_HOME);
			expect(existsSync(join(home, 'personal', 'smoke-personal-rule.md')), 'the personal record is not in the Memory home');
			// The smoke repository has no origin, so its layer is keyed by the folder name.
			expect(existsSync(join(home, 'projects', 'local', 'repo', 'smoke-project-fact.md')), 'the project record is not keyed local/repo');
			const log = exec(world, 'git', ['log', '--format=%s'], { cwd: home });
			expect(log.status === 0 && log.stdout.trim().split('\n').length === 2, `the Memory home does not hold one commit per write: ${log.stdout.trim()}`);
			kalfa(world, ['memory', 'confirm', 'smoke-personal-rule', 'read back in the smoke']);
			expect(kalfa(world, ['memory', 'show', 'smoke-personal-rule']).includes('confirm smoke-personal-rule: read back in the smoke'), 'show does not list the proof of the confirm');
			const start = exec(world, 'sh', ['-c', installedHook(world, 'SessionStart')], { input: hookPayload(world, 'SessionStart', { source: 'startup' }) });
			expect(start.status === 0, `session.start exited ${start.status}: ${start.stderr.trim()}`);
			const output = JSON.parse(start.stdout || '{}');
			const context = String(output.hookSpecificOutput?.additionalContext ?? '');
			expect(context.includes(PERSONAL_RULE) && context.includes(`[fact] ${PROJECT_FACT}`), 'session.start does not inject both layers');
			expect(String(output.systemMessage ?? '').includes('memory: 1 rule, 1 index line'), `the summary does not count the records: ${output.systemMessage}`);
		},
	},
	{
		name: 'memory Module: Task close puts the candidates into the inbox, accept writes a record, search finds it',
		run(world) {
			cpSync(join(world.packageRoot, 'modules', 'memory'), join(world.root, 'modules', 'memory'), { recursive: true });
			const project = parse(read(world, 'kalfa.yaml'));
			writeFileSync(join(world.repo, 'kalfa.yaml'), stringify({ ...project, modules: [...project.modules, 'memory'] }));
			kalfa(world, ['build']);
			const parts = `**Done:** smoke work.\n\n**Memory candidates:**\n- ${CANDIDATE}\n\n**Next:** nothing.`;
			const section = exec(world, 'kalfa', ['section', 'close', 'Smoke section'], { input: parts });
			expect(section.status === 0, `kalfa section close exited ${section.status}: ${section.stderr.trim()}`);
			const close = kalfa(world, ['task', 'close']);
			expect(close.includes('Ask the Operator ONE question') && close.includes(CANDIDATE), `task close does not ask about the candidate: ${close.trim()}`);
			const home = join(world.home, MEMORY_HOME);
			const copies = readdirSync(join(home, 'projects', 'local', 'repo', 'tasks'));
			expect(copies.length === 1, `the Task Record is not copied into the Memory home: ${copies.join(', ')}`);
			const id = kalfa(world, ['memory', 'inbox']).split(/\s/)[0]!;
			kalfa(world, ['memory', 'inbox', 'accept', id, '--type', 'fact', '--layer', 'project', '--summary', ACCEPTED]);
			expect(kalfa(world, ['memory', 'inbox']).includes('the inbox is empty'), 'accept left the candidate in the inbox');
			expect(kalfa(world, ['memory', 'search', 'accepted candidate']).includes(`[memory] fact: ${ACCEPTED}`), 'search does not find the accepted record');
			expect(kalfa(world, ['memory', 'lint']).trim() === 'no findings', 'the lint has findings on fresh records');
		},
	},
	{
		name: 'uninstall: no Modules, kalfa uninstall, then kalfa unlink, leave nothing behind',
		run(world) {
			const project = parse(read(world, 'kalfa.yaml'));
			writeFileSync(join(world.repo, 'kalfa.yaml'), stringify({ ...project, modules: [] }));
			kalfa(world, ['build']);
			// kalfa rewrites the settings file with its own JSON layout; compare its content.
			expect(isDeepStrictEqual(JSON.parse(read(world, SETTINGS)), OPERATOR_SETTINGS), "the settings file is not the Operator's own again");
			const left = differences(world.afterInit!, snapshot(world.repo, ['.git', '.kalfa'])).filter((d) => d !== `${SETTINGS} changed` && d !== 'kalfa.yaml changed');
			expect(!left.length, `the repository differs from right after init: ${left.join('; ')}`);
			kalfa(world, ['uninstall'], world.home);
			expect(isDeepStrictEqual(userSettings(world), OPERATOR_USER_SETTINGS), "the user settings are not the Operator's own again");
			kalfa(world, ['unlink'], world.home);
			// The bin and cache folders are the user's own; kalfa leaves them, empty. Its backups stay.
			const backup = new RegExp(`^${USER_SETTINGS.replace(/\./g, '\\.')}\\.bak-kalfa-\\S+ is new$`);
			const userFolders = ['.local', relative(world.home, world.bin), '.cache'].map((path) => `${path} is new`);
			// The Memory home holds the Operator's records, not kalfa's install: it stays.
			const memory = (d: string) => MEMORY_HOME.split('/').some((_, i, parts) => d === `${parts.slice(0, i + 1).join('/')} is new`) || d.startsWith(`${MEMORY_HOME}/`);
			const home = differences(world.homeBefore!, snapshot(world.home)).filter((d) => !userFolders.includes(d) && d !== `${USER_SETTINGS} changed` && !backup.test(d) && !memory(d));
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
	writeFiles(home, HOME_FILES);
	writeFiles(modules, SMOKE_MODULE);
	writeFiles(repo, REPO_FILES);
	const env: NodeJS.ProcessEnv = { HOME: home, PATH: [bin, dirname(process.execPath), ...cleanPath(process.env.PATH)].join(delimiter), KALFA_MODULES_DIR: modules, GIT_CONFIG_NOSYSTEM: '1' };
	if (process.env.TMPDIR) env.TMPDIR = process.env.TMPDIR;
	const world: World = { packageRoot, root, home, bin, repo, env, homeBefore: snapshot(home) };
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
	return 0;
}
