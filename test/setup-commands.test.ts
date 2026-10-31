import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { claudeAdapter } from '../src/adapters/claude/adapter.ts';
import { doctorCommand } from '../src/cli/commands/doctor.ts';
import { initCommand } from '../src/cli/commands/init.ts';
import { linkCommand, unlinkCommand } from '../src/cli/commands/link.ts';
import { fakeAdapter } from './fakes.ts';
import { captureIo, gitRepo, tempDir, tempRepo } from './helpers.ts';

const modulesDir = tempRepo({
	'guardrails/module.yaml': 'schema: 1\ndescription: d\nneeds:\n  - capability: command-block\n    without: the push gate only warns\n',
	'guardrails/rules/r.md': 'Rule.\n',
});
const adapters = new Map([['claude', claudeAdapter]]);
const init = initCommand(adapters, () => [modulesDir]);
const read = (root: string, path: string) => readFileSync(join(root, path), 'utf8');

async function run(command: { run: (args: string[], io: ReturnType<typeof captureIo>) => Promise<number> }, cwd: string, args: string[] = [], env?: NodeJS.ProcessEnv) {
	const io = captureIo(cwd, env);
	const code = await command.run(args, io);
	return { code, out: io.stdout.join('\n'), err: io.stderr.join('\n') };
}

test('init writes kalfa.yaml, ignores .kalfa/, finds the Plans and imports AGENTS.md into CLAUDE.md', async () => {
	const root = gitRepo({
		'.gitignore': 'node_modules/',
		'AGENTS.md': '# Agents\n',
		'CLAUDE.md': 'Claude-only line.\n',
		'docs/plan.md': '---\ntype: plan\ntitle: P\nstatus: active\n---\n- [ ] step\n',
	});
	const out = await run(init, root, ['--module', 'guardrails']);
	assert.equal(out.code, 0);
	assert.equal(read(root, 'kalfa.yaml'), "schema: 1\nmodules:\n  - guardrails\nplans:\n  - docs/**/*.md\n");
	assert.equal(read(root, '.gitignore'), 'node_modules/\n.kalfa/\n');
	assert.equal(read(root, 'CLAUDE.md'), '@AGENTS.md\n\nClaude-only line.\n');
	assert.match(out.out, /next: kalfa build$/);

	await assert.rejects(run(init, root), /kalfa\.yaml exists already/);
});

test('init leaves an existing import and ignore alone, and only hints when there is no AGENTS.md', async () => {
	const imported = gitRepo({ '.gitignore': '.kalfa/\n', 'AGENTS.md': 'a\n', 'CLAUDE.md': '@AGENTS.md\nmore\n' });
	await run(init, imported);
	assert.equal(read(imported, '.gitignore'), '.kalfa/\n');
	assert.equal(read(imported, 'CLAUDE.md'), '@AGENTS.md\nmore\n');
	assert.equal(read(imported, 'kalfa.yaml'), 'schema: 1\nmodules: []\nplans: []\n');

	const claudeOnly = gitRepo({ 'CLAUDE.md': 'all instructions\n' });
	const out = await run(init, claudeOnly);
	assert.match(out.out, /note: CLAUDE\.md holds this repository's instructions; move the part every harness needs to AGENTS\.md/);
	assert.equal(read(claudeOnly, 'CLAUDE.md'), 'all instructions\n');
});

test('init --dry-run writes nothing, and an unknown Module is refused', async () => {
	const root = gitRepo({ 'AGENTS.md': 'a\n', 'CLAUDE.md': 'c\n' });
	const out = await run(init, root, ['--dry-run']);
	assert.match(out.out, /write kalfa\.yaml \(commit it\):\n {2}schema: 1\n {2}modules: \[\]\n {2}plans: \[\]\nadd \.kalfa\/ to \.gitignore[\s\S]*import AGENTS\.md at the top of CLAUDE\.md[\s\S]*dry run: nothing was written$/);
	assert.equal(existsSync(join(root, 'kalfa.yaml')), false);
	assert.equal(existsSync(join(root, '.gitignore')), false);
	await assert.rejects(run(init, root, ['--module', 'nope']), /unknown Module 'nope'/);
});

function checkout(): string {
	const root = tempRepo({ 'package.json': '{}', 'dist/kalfa.mjs': '', 'dist/kalfa-hook': '' });
	return root;
}

test('link points the bin folder at this checkout, unlink removes only those links', async () => {
	const pkg = checkout();
	const bin = join(tempDir(), 'bin');
	const env = { KALFA_BIN_DIR: bin };
	const linked = await run(linkCommand(() => pkg), tempDir(), [], env);
	assert.match(linked.out, new RegExp(`link ${bin}/kalfa → ${pkg}/dist/kalfa\\.mjs\\nlink ${bin}/kalfa-hook → ${pkg}/dist/kalfa-hook`));
	assert.equal((await run(linkCommand(() => pkg), tempDir(), [], env)).out, `kalfa runs from ${pkg}`, 'a second link changes nothing');

	const other = checkout();
	await assert.rejects(run(linkCommand(() => other), tempDir(), [], env), /links to .*; run kalfa unlink from that checkout first/);
	const refused = await run(unlinkCommand(() => other), tempDir(), [], env);
	assert.match(refused.err, /not to this checkout; left in place/);

	assert.match((await run(unlinkCommand(() => pkg), tempDir(), [], env)).out, /remove .*kalfa\nremove .*kalfa-hook/);
	assert.equal(existsSync(join(bin, 'kalfa')), false);
});

test('link refuses a plain file in the bin folder and a checkout that is not built', async () => {
	const bin = tempDir();
	writeFileSync(join(bin, 'kalfa'), 'installed\n');
	await assert.rejects(run(linkCommand(() => checkout()), tempDir(), [], { KALFA_BIN_DIR: bin }), /exists and is not a link/);
	await assert.rejects(run(linkCommand(() => tempRepo({ 'package.json': '{}' })), tempDir(), [], { KALFA_BIN_DIR: tempDir() }), /run npm run build/);
});

test('doctor shows the install mode, the Capabilities that are off and whether the build is up to date', async () => {
	const pkg = checkout();
	const bin = tempDir();
	symlinkSync(join(pkg, 'dist/kalfa.mjs'), join(bin, 'kalfa'));
	const limited = { ...fakeAdapter, name: 'limited', capabilities: new Set(['context-injection'] as const) };
	const doctor = doctorCommand(new Map([['claude', claudeAdapter], ['limited', limited]]), () => [modulesDir], () => pkg);
	const root = gitRepo({ '.gitignore': '.kalfa/\n.claude/\n', 'kalfa.yaml': 'schema: 1\nmodules: [guardrails]\n' });
	const env = { HOME: tempDir(), PATH: `/nowhere:${bin}` };

	const before = (await run(doctor, root, [], env)).out;
	assert.match(before, new RegExp(`install: linked to this checkout \\(${bin}/kalfa\\)`));
	assert.match(before, /Capabilities:\n {2}claude: all on\n {2}limited: 2 off\n {4}core without task-list: a closed Section stays in the Task Record only\n {4}guardrails without command-block: the push gate only warns/);
	assert.match(before, /build: 1 change\(s\) waiting; run kalfa build\n[\s\S]*write \.claude\/rules\/kalfa-guardrails-r\.md/);
	assert.equal(existsSync(join(root, '.claude')), false, 'doctor writes nothing');

	mkdirSync(join(root, '.claude/rules'), { recursive: true });
	writeFileSync(join(root, '.claude/rules/kalfa-guardrails-r.md'), 'mine\n');
	assert.match((await run(doctor, root, [], env)).out, /build: problem: kalfa build changed nothing:\n- \.claude\/rules\/kalfa-guardrails-r\.md: exists and kalfa did not write it/);
});

test('doctor names the skill references that no installed skill answers', async () => {
	const home = tempRepo({ '.claude/skills/present/SKILL.md': 'x' });
	const root = gitRepo({ 'AGENTS.md': 'Use the `present` skill.\n', 'CLAUDE.md': '@AGENTS.md\n\nRun `/compact`, then `/gone`.\n' });
	const doctor = doctorCommand(adapters, () => [modulesDir], () => checkout());
	assert.match((await run(doctor, root, [], { HOME: home })).out, /skill references:\n {2}claude: 1 of 3 not found\n {4}CLAUDE\.md:3: gone\n {4}\(not a skill\? add it to skill-refs/);
});

test('doctor leaves out the skill references that kalfa.yaml ignores, and counts them', async () => {
	const home = tempRepo({});
	const root = gitRepo({ 'kalfa.yaml': 'schema: 1\nskill-refs:\n  ignore: [callback]\n', 'CLAUDE.md': 'The redirect goes to `/callback`.\n' });
	const doctor = doctorCommand(adapters, () => [modulesDir], () => checkout());
	assert.match((await run(doctor, root, [], { HOME: home })).out, /skill references:\n {2}claude: 0 found \(1 ignored\)$/m);
});

test('doctor lists the Module folders and flags a missing one and a Module in two', async () => {
	const clash = tempRepo({ 'guardrails/module.yaml': 'schema: 1\ndescription: d\n' });
	const missing = join(tempDir(), 'gone');
	const doctor = doctorCommand(adapters, () => [modulesDir, clash, missing], () => checkout());
	const { out } = await run(doctor, tempDir(), [], { HOME: tempDir() });
	assert.match(out, new RegExp(`Module folders: 3\n {2}${modulesDir} \\(the package\\): 1 Module\\(s\\)\n {2}${clash}: 1 Module\\(s\\)\n {2}${missing}: problem: not found\n {2}problem: Module 'guardrails' is in more than one folder`));
});
