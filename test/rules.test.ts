import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Adapter } from '../src/adapters/adapter.ts';
import { claudeAdapter } from '../src/adapters/claude/adapter.ts';
import { claudeRules } from '../src/adapters/claude/rules.ts';
import { buildCommand } from '../src/cli/commands/build.ts';
import { doctorCommand } from '../src/cli/commands/doctor.ts';
import { installCommand, uninstallCommand } from '../src/cli/commands/install.ts';
import { ruleCommand } from '../src/cli/commands/rule.ts';
import type { Capability } from '../src/core/capabilities.ts';
import { KalfaError } from '../src/core/errors.ts';
import { allLayers, memoryHome, personalLayer, projectLayer, readLayer, writeRecords } from '../src/core/memory/home.ts';
import type { MemoryRecord } from '../src/core/memory/record.ts';
import { loadedRules, planRuleFiles, rulesReport } from '../src/core/rules/files.ts';
import { checkPackRule, commitPack, type PackRule, readPack, scanPack } from '../src/core/rules/pack.ts';
import { sessionRules } from '../src/core/rules/session.ts';
import { applyUserRules } from '../src/core/rules/user-files.ts';
import { captureIo, gitRepo, tempDir, tempRepo } from './helpers.ts';

const adapters = new Map<string, Adapter>([['claude', claudeAdapter]]);
const modulesDir = tempRepo({ 'guardrails/module.yaml': 'schema: 1\ndescription: Hard rules.\n' });
const moduleDirs = () => [modulesDir];
const pkg = tempRepo({ 'package.json': '{}\n', 'dist/kalfa-hook': '', 'dist/adapters/claude/status-tap': '' });
const LIMITS = { ruleChars: 600 };
const ALL: ReadonlySet<Capability> = claudeAdapter.capabilities;
const NONE: ReadonlySet<Capability> = new Set(['instruction-file']);

/** A machine with its own HOME (so its Memory home), and a kalfa repository with an origin. */
function machine() {
	const home = tempRepo({ '.config/kalfa/config.yaml': 'schema: 1\nmodules: []\n' });
	const repo = gitRepo({ 'kalfa.yaml': 'schema: 1\nmodules: []\n', '.gitignore': '.kalfa/\n.claude/\n' });
	execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', 'git@github.com:Someone/Project.git']);
	return { home, repo, env: { HOME: home } as NodeJS.ProcessEnv };
}

async function rule(env: NodeJS.ProcessEnv, cwd: string, args: string[], stdin = '') {
	const io = captureIo(cwd, env, stdin);
	try {
		const code = await ruleCommand(adapters, moduleDirs).run(args, io);
		return { code, out: io.stdout.join('\n'), err: io.stderr.join('\n'), error: undefined };
	} catch (error) {
		if (error instanceof KalfaError) return { code: 1, out: io.stdout.join('\n'), err: io.stderr.join('\n'), error: error.message };
		throw error;
	}
}

async function command(run: (args: string[], io: ReturnType<typeof captureIo>) => Promise<number>, env: NodeJS.ProcessEnv, cwd: string, ...args: string[]) {
	const io = captureIo(cwd, env);
	const code = await run(args, io);
	return { code, out: io.stdout.join('\n') };
}

const install = installCommand(adapters, moduleDirs, () => pkg);
const uninstall = uninstallCommand(adapters, moduleDirs);
const build = buildCommand(adapters, moduleDirs);
const doctor = doctorCommand(adapters, moduleDirs, () => pkg);
const gitLog = (env: NodeJS.ProcessEnv) => execFileSync('git', ['-C', memoryHome(env), 'log', '--format=%s'], { encoding: 'utf8' }).trim().split('\n');
const read = (base: string, path: string) => readFileSync(join(base, path), 'utf8');

const ALWAYS: PackRule = { id: 'stage-by-name', form: 'always', text: 'Stage files by name.\nAn untracked file can be untracked on purpose.' };
const SCOPED: PackRule = { id: 'pin-images', form: 'path', text: 'Pin every image by digest.', paths: ['k8s/**/*.yaml'] };
const SKILL: PackRule = { id: 'kernel-upgrade', form: 'skill', text: 'Run sudo apt full-upgrade.\nThen run nvidia-smi.', description: 'Upgrading the kernel on the laptop.' };

test('a Rule pack keeps each form in its file, and reads back what it wrote', () => {
	const { env } = machine();
	const layer = personalLayer(memoryHome(env));
	commitPack(memoryHome(env), [{ layer, write: [ALWAYS, SCOPED, SKILL] }], 'three rules');
	assert.equal(read(layer.dir, 'rules/stage-by-name.md'), `${ALWAYS.text}\n`);
	assert.match(read(layer.dir, 'rules/pin-images.md'), /^---\npaths:\n {2}- k8s\/\*\*\/\*\.yaml\n---\n\nPin every image/);
	assert.match(read(layer.dir, 'skills/kernel-upgrade/SKILL.md'), /^---\nname: kernel-upgrade\ndescription: Upgrading the kernel on the laptop\.\n---\n/);
	assert.deepEqual(
		readPack(layer).sort((a, b) => a.id.localeCompare(b.id)),
		[SKILL, SCOPED, ALWAYS],
	);
	assert.deepEqual(gitLog(env), ['three rules']);
});

test('a broken pack file is left out of a scan and refused by a read', () => {
	const { env } = machine();
	const layer = personalLayer(memoryHome(env));
	mkdirSync(join(layer.dir, 'rules'), { recursive: true });
	mkdirSync(join(layer.dir, 'skills/other'), { recursive: true });
	writeFileSync(join(layer.dir, 'rules/good.md'), 'A rule.\n');
	writeFileSync(join(layer.dir, 'rules/bad.md'), '---\nscope: all\n---\nA rule.\n');
	writeFileSync(join(layer.dir, 'skills/other/SKILL.md'), '---\nname: different\ndescription: x\n---\nSteps.\n');
	const scan = scanPack(layer);
	assert.deepEqual(scan.rules.map((r) => r.id), ['good']);
	assert.equal(scan.problems.length, 2);
	assert.throws(() => readPack(layer), /only `paths:`/);
});

test('the checks refuse a long rule, a bad path pattern and a skill with no description', () => {
	assert.throws(() => checkPackRule({ ...ALWAYS, text: 'x'.repeat(601) }, LIMITS), /601 characters \(limit 600\)/);
	for (const glob of ['/etc/**', '../other/**', '~/x', '']) assert.throws(() => checkPackRule({ ...SCOPED, paths: [glob] }, LIMITS), /path pattern/, glob);
	assert.throws(() => checkPackRule({ ...SCOPED, paths: [] }, LIMITS), /at least one path/);
	assert.throws(() => checkPackRule({ ...SKILL, description: ' ' }, LIMITS), /description/);
	assert.throws(() => checkPackRule({ ...ALWAYS, id: 'Not An Id' }, LIMITS), /not a rule id/);
	// A skill is a procedure: its length is not limited.
	assert.equal(checkPackRule({ ...SKILL, text: 'step\n'.repeat(300) }, LIMITS).form, 'skill');
});

test('a harness without path-rules loads a scoped rule always, and without skills gets a pointer line', () => {
	const layer = personalLayer('/home/x/memory');
	const full = loadedRules(layer, [ALWAYS, SCOPED, SKILL], ALL);
	assert.deepEqual(full.always.map((r) => r.id), ['stage-by-name']);
	assert.deepEqual(full.scoped.map((r) => r.id), ['pin-images']);
	assert.deepEqual(full.skills.map((r) => r.id), ['kernel-upgrade']);

	const bare = loadedRules(layer, [ALWAYS, SCOPED, SKILL], NONE);
	assert.deepEqual(bare.always.map((r) => r.id), ['stage-by-name', 'pin-images', 'kernel-upgrade']);
	assert.equal(bare.scoped.length + bare.skills.length, 0);
	assert.match(bare.always[1]!.text, /It applies to the files that match k8s\/\*\*\/\*\.yaml/);
	assert.match(bare.always[2]!.text, /Upgrading the kernel on the laptop\. Read the procedure in \/home\/x\/memory\/personal\/skills\/kernel-upgrade\/SKILL\.md first/);
});

test('Claude gets one file for the rules that load always and one per path-scoped rule', () => {
	const layer = projectLayer('/m', { root: '/nowhere', file: undefined });
	const planned = planRuleFiles({ ...layer, label: 'github.com/someone/project' }, [ALWAYS, SCOPED, SKILL], claudeRules, ALL);
	assert.deepEqual([...planned.files.keys()], ['.claude/rules/kalfa-project/always.md', '.claude/rules/kalfa-project/paths/pin-images.md']);
	const always = planned.files.get('.claude/rules/kalfa-project/always.md')!;
	assert.match(always, /^# Rules of the Project layer \(github\.com\/someone\/project\) \(kalfa\)\n/);
	assert.match(always, /\n- Stage files by name\.\n {2}An untracked file can be untracked on purpose\. \(stage-by-name\)\n$/);
	assert.match(planned.files.get('.claude/rules/kalfa-project/paths/pin-images.md')!, /^---\npaths:\n {2}- k8s\/\*\*\/\*\.yaml\n---\n<!-- Written by kalfa/);
	assert.deepEqual(planned.skills.map((s) => s.target), ['.claude/skills/kernel-upgrade']);
	assert.deepEqual(planRuleFiles(layer, [], claudeRules, ALL).files.size, 0, 'no rules, no file');
});

test('the session report form names each rule and the scoped ones with their paths', () => {
	const rules = loadedRules(personalLayer('/m'), [ALWAYS, SCOPED], ALL);
	const text = rulesReport(rules, 'kalfa install writes them as files');
	assert.match(text, /^Rules of the Personal layer \(its Rule pack; kalfa install writes them as files\):\n- Stage files by name\./);
	assert.match(text, /- Pin every image by digest\.\n {2}\(It applies to the files that match k8s\/\*\*\/\*\.yaml\.\) \(pin-images\)$/);
	assert.equal(rulesReport(loadedRules(personalLayer('/m'), [], ALL), 'x'), '');
});

test('the personal files: kalfa owns the rules folder, links its skills, and never touches a skill it did not link', () => {
	const { env, home } = machine();
	const layer = personalLayer(memoryHome(env));
	commitPack(memoryHome(env), [{ layer, write: [ALWAYS, SCOPED, SKILL] }], 'rules');
	const planned = planRuleFiles(layer, readPack(layer), claudeRules, ALL);
	mkdirSync(join(home, '.claude/rules/kalfa-personal'), { recursive: true });
	writeFileSync(join(home, '.claude/rules/kalfa-personal/stray.md'), 'old');

	const dry = applyUserRules(home, claudeRules, planned, undefined, true);
	assert.ok(dry.changed);
	assert.ok(!existsSync(join(home, '.claude/rules/kalfa-personal/always.md')), 'a dry run writes nothing');

	const first = applyUserRules(home, claudeRules, planned, undefined, false);
	assert.deepEqual(first.owned, { dir: '.claude/rules/kalfa-personal', skills: ['.claude/skills/kernel-upgrade'] });
	assert.ok(existsSync(join(home, '.claude/rules/kalfa-personal/always.md')));
	assert.ok(existsSync(join(home, '.claude/rules/kalfa-personal/paths/pin-images.md')));
	assert.ok(!existsSync(join(home, '.claude/rules/kalfa-personal/stray.md')), 'a file kalfa did not plan goes from its folder');
	assert.equal(readlinkSync(join(home, '.claude/skills/kernel-upgrade')), join(layer.dir, 'skills/kernel-upgrade'));
	assert.equal(applyUserRules(home, claudeRules, planned, first.owned, false).changed, false, 'a second run changes nothing');

	// The Operator's own skill of the same name stays; kalfa says so and does not own it.
	const other = machine();
	mkdirSync(join(other.home, '.claude/skills/kernel-upgrade'), { recursive: true });
	const blocked = applyUserRules(other.home, claudeRules, planned, undefined, false);
	assert.deepEqual(blocked.owned?.skills, []);
	assert.match(blocked.report.join('\n'), /kalfa did not link it/);
	assert.ok(!lstatSync(join(other.home, '.claude/skills/kernel-upgrade')).isSymbolicLink());

	const removed = applyUserRules(home, claudeRules, undefined, first.owned, false);
	assert.equal(removed.owned, undefined);
	assert.ok(!existsSync(join(home, '.claude/rules/kalfa-personal')));
	assert.ok(!existsSync(join(home, '.claude/skills/kernel-upgrade')));
});

test('kalfa rule add, change, list and remove write the pack and commit each change', async () => {
	const { env, repo } = machine();
	const added = await rule(env, repo, ['add', '--layer', 'personal', '--summary', 'Stage files by name.'], 'An untracked file can be untracked on purpose.');
	assert.equal(added.code, 0, added.error);
	assert.match(added.out, /Added the rule stage-files-by-name \(always\)/);
	const scoped = await rule(env, repo, ['add', '--layer', 'project', '--summary', 'Pin every image.', '--path', 'k8s/**', '--path', 'charts/**', '--id', 'pin']);
	assert.equal(scoped.code, 0, scoped.error);
	const list = await rule(env, repo, ['list']);
	assert.match(list.out, /personal:\n {2}stage-files-by-name {2}always {2}Stage files by name\./);
	assert.match(list.out, /github\.com\/someone\/project:\n {2}pin {2}path k8s\/\*\*, charts\/\*\* {2}Pin every image\./);

	// A form change moves the file; the reasons stay when stdin is empty.
	const skill = await rule(env, repo, ['change', 'stage-files-by-name', '--skill', 'Staging files for a commit.']);
	assert.equal(skill.code, 0, skill.error);
	const layer = personalLayer(memoryHome(env));
	assert.ok(!existsSync(join(layer.dir, 'rules/stage-files-by-name.md')));
	assert.deepEqual(readPack(layer), [{ id: 'stage-files-by-name', form: 'skill', text: 'Stage files by name.\nAn untracked file can be untracked on purpose.', description: 'Staging files for a commit.' }]);
	const same = await rule(env, repo, ['change', 'stage-files-by-name']);
	assert.match(same.error ?? '', /nothing to change/);

	const removed = await rule(env, repo, ['remove', 'pin', 'the', 'cluster', 'went']);
	assert.equal(removed.code, 0, removed.error);
	assert.deepEqual(readPack(projectLayer(memoryHome(env), { root: repo, file: undefined })), []);
	assert.deepEqual(gitLog(env), [
		'remove rule pin (github.com/someone/project): the cluster went',
		'change rule stage-files-by-name (personal, skill)',
		'add rule pin (github.com/someone/project, path)',
		'add rule stage-files-by-name (personal, always)',
	]);
	assert.ok(!existsSync(join(layer.dir, 'skills/kernel-upgrade')));
});

test('kalfa rule refuses a missing layer, two forms at once, and a project layer outside a repository', async () => {
	const { env, repo } = machine();
	assert.equal((await rule(env, repo, ['add', '--summary', 'X.'])).code, 1);
	assert.match((await rule(env, repo, ['add', '--layer', 'personal', '--summary', 'X.', '--path', 'a/**', '--skill', 'y'])).error ?? '', /one form/);
	const outside = await rule(env, tempDir(), ['add', '--layer', 'project', '--summary', 'X.']);
	assert.match(outside.error ?? '', /needs a git repository/);
	const long = await rule(env, repo, ['add', '--layer', 'personal', '--summary', 'X.'], 'y'.repeat(700));
	assert.match(long.error ?? '', /short and exact/);
	assert.equal(existsSync(join(memoryHome(env), '.git')), false, 'nothing was committed');
});

/** An active rule record, as the old Standing memory kept a rule. */
const ruleRecord = (id: string, summary: string, body = ''): MemoryRecord => ({
	id,
	header: { schema: 1, type: 'rule', status: 'active', summary, created: '2026-11-01', confirmed: '2026-11-01' },
	body,
});

test('kalfa rule migrate moves every active rule record into its pack, unchanged and loading always, and closes it', async () => {
	const { env, repo } = machine();
	const home = memoryHome(env);
	const personal = personalLayer(home);
	const project = projectLayer(home, { root: repo, file: undefined });
	const fact: MemoryRecord = { ...ruleRecord('a-fact', 'A fact.'), header: { ...ruleRecord('a-fact', 'A fact.').header, type: 'fact' } };
	writeRecords(
		home,
		[
			{ layer: personal, record: ruleRecord('stage-by-name', 'Stage files by name.', 'Operator, 2026-11-01: "never add -A".') },
			{ layer: personal, record: fact },
			{ layer: project, record: ruleRecord('pin-images', 'Pin every image.') },
		],
		'old records',
	);
	assert.deepEqual(allLayers(home).map((l) => l.label), ['personal', 'github.com/someone/project']);

	const dry = await rule(env, repo, ['migrate', '--dry-run']);
	assert.match(dry.out, /dry run: 2 rule\(s\) would move/);
	assert.deepEqual(readPack(personal), []);

	const run = await rule(env, repo, ['migrate']);
	assert.equal(run.code, 0, run.error);
	assert.deepEqual(readPack(personal), [{ id: 'stage-by-name', form: 'always', text: 'Stage files by name.\nOperator, 2026-11-01: "never add -A".' }]);
	assert.deepEqual(readPack(project), [{ id: 'pin-images', form: 'always', text: 'Pin every image.' }]);
	const records = readLayer(personal);
	const moved = records.find((r) => r.id === 'stage-by-name')!;
	assert.equal(moved.header.status, 'closed');
	assert.match(moved.body, /Moved to the Rule pack on \d{4}-\d{2}-\d{2}: .*personal\/rules\/stage-by-name\.md\.$/);
	assert.equal(records.find((r) => r.id === 'a-fact')!.header.status, 'active', 'a fact stays');
	assert.equal(gitLog(env)[0], 'migrate 2 rule record(s) to the Rule packs');
	// This repository's layer moved too, so its build ran here.
	assert.ok(existsSync(join(repo, '.claude/rules/kalfa-project/always.md')));

	const again = await rule(env, repo, ['migrate']);
	assert.match(again.out, /no active rule records/);
});

test('kalfa install writes the personal rules and records them; uninstall removes them', async () => {
	const { env, home, repo } = machine();
	await rule(env, repo, ['add', '--layer', 'personal', '--summary', 'Stage files by name.']);
	const installed = await command(install.run, env, home);
	assert.equal(installed.code, 0, installed.out);
	assert.match(read(home, '.claude/rules/kalfa-personal/always.md'), /- Stage files by name\. \(stage-files-by-name\)/);
	const state = JSON.parse(read(home, '.config/kalfa/install.yaml'));
	assert.deepEqual(state.harnesses.claude.rules, { dir: '.claude/rules/kalfa-personal', skills: [] });

	// After the install each rule write writes the files again.
	const added = await rule(env, repo, ['add', '--layer', 'personal', '--summary', 'Ask before infra.']);
	assert.match(added.out, /Personal rules written for claude/);
	assert.match(read(home, '.claude/rules/kalfa-personal/always.md'), /Ask before infra\./);

	await command(uninstall.run, env, home);
	assert.ok(!existsSync(join(home, '.claude/rules/kalfa-personal')));
});

test('kalfa build writes the project rules into the git-ignored folder, and removes a rule that went', async () => {
	const { env, repo } = machine();
	await rule(env, repo, ['add', '--layer', 'project', '--summary', 'Pin every image.', '--path', 'k8s/**', '--id', 'pin']);
	await rule(env, repo, ['add', '--layer', 'project', '--summary', 'Write a Log.', '--id', 'log']);
	assert.ok(existsSync(join(repo, '.claude/rules/kalfa-project/always.md')), 'a rule write runs the build');
	assert.match(read(repo, '.claude/rules/kalfa-project/paths/pin.md'), /^---\npaths:\n {2}- k8s\/\*\*\n---\n/);
	const state = JSON.parse(read(repo, '.kalfa/build.yaml'));
	assert.ok(state.harnesses.claude.files['.claude/rules/kalfa-project/paths/pin.md']);

	// A skill-form rule is copied like a Module's skill.
	await rule(env, repo, ['add', '--layer', 'project', '--summary', 'Tag, then push the tag.', '--skill', 'Releasing a version.', '--id', 'release']);
	assert.match(read(repo, '.claude/skills/release/SKILL.md'), /^---\nname: release\ndescription: Releasing a version\.\n---\n\nTag, then push the tag\.\n$/);
	await rule(env, repo, ['remove', 'release', 'gone']);
	assert.ok(!existsSync(join(repo, '.claude/skills/release')));

	await rule(env, repo, ['remove', 'pin', 'gone']);
	assert.ok(!existsSync(join(repo, '.claude/rules/kalfa-project/paths/pin.md')));
	const again = await command(build.run, env, repo);
	assert.match(again.out, /1 file\(s\) unchanged/);
});

test('the session start loads a layer from its files, or puts its rules in the report until they are written', async () => {
	const { env, repo, home } = machine();
	const layouts = { user: claudeAdapter.user!.rules, project: claudeAdapter.project!.rules };
	const project = { root: repo, file: { schema: 1 as const, modules: [], plans: [], settings: {} } };
	assert.deepEqual(sessionRules(project, env, 'claude', layouts, ALL), { context: undefined, notice: undefined, inReport: 0 }, 'no rules, nothing to say');

	const layer = personalLayer(memoryHome(env));
	commitPack(memoryHome(env), [{ layer, write: [ALWAYS] }, { layer: projectLayer(memoryHome(env), project), write: [SCOPED] }], 'rules');
	const before = sessionRules(project, env, 'claude', layouts, ALL);
	assert.equal(before.inReport, 2);
	assert.match(before.context!, /Rules of the Personal layer \(its Rule pack; kalfa install writes them as files\):\n- Stage files by name\./);
	assert.match(before.context!, /Rules of the Project layer \(github\.com\/someone\/project\)/);
	assert.match(before.notice!, /kalfa build writes them as files here/);

	await command(install.run, env, home);
	await command(build.run, env, repo);
	assert.deepEqual(sessionRules(project, env, 'claude', layouts, ALL), { context: undefined, notice: undefined, inReport: 0 });

	// A change in the pack by hand: the session start writes the personal files again.
	writeFileSync(join(layer.dir, 'rules/stage-by-name.md'), 'Stage files by their names.\n');
	assert.equal(sessionRules(undefined, env, 'claude', layouts, ALL).inReport, 0);
	assert.match(read(home, '.claude/rules/kalfa-personal/always.md'), /Stage files by their names\./);
});

test('kalfa doctor shows each layer against its files and warns over the count limit', async () => {
	const { env, repo } = machine();
	for (let n = 0; n < 16; n++) await rule(env, repo, ['add', '--layer', 'project', '--summary', `Rule number ${n}.`]);
	const out = (await command(doctor.run, env, repo)).out;
	assert.match(out, /rules:\n {2}personal: no rules\n {2}github\.com\/someone\/project: 16 rule\(s\): 16 always, 0 by path, 0 skill\(s\)/);
	assert.match(out, /warning: 16 rules load always \(limit 15\)/);
	assert.match(out, /claude: files current/);
	writeFileSync(join(repo, '.claude/rules/kalfa-project/always.md'), 'edited by hand\n');
	assert.match((await command(doctor.run, env, repo)).out, /claude: 0 missing, 1 changed; run kalfa build/);
});
