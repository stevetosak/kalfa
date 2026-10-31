import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { sectionCommand, taskCommand } from '../../src/cli/commands/task.ts';
import type { CoreEvent } from '../../src/core/events.ts';
import { loadProject } from '../../src/core/project.ts';
import { readRecord } from '../../src/core/task-record.ts';
import { coreModule } from '../../src/modules/core.ts';
import { fakeAdapter, handlerContext, registry } from '../../test/fakes.ts';
import { captureIo, gitRepo, tempDir } from '../../test/helpers.ts';
import { docsCommand } from './command.ts';
import { logDraft, slugOf } from './draft.ts';
import { judge } from './gate.ts';
import { docsModule } from './handlers.ts';
import { docsSkipReason, isPrCreate, parsePrCreate } from './pr-command.ts';

test('only `gh pr create` in command position is a PR creation', () => {
	assert.ok(isPrCreate('gh pr create --title x'));
	assert.ok(isPrCreate('cd ~/repo && gh pr create --fill'));
	assert.ok(isPrCreate('GH_TOKEN=x gh pr create'));
	assert.ok(isPrCreate('git push && gh pr create'));
	assert.ok(!isPrCreate('gh pr view 4'));
	assert.ok(!isPrCreate('echo gh pr create'));
	assert.ok(!isPrCreate('git commit -m "docs: gh pr create is gated"'));
});

test('PR flags are read in every spelling the agent writes', () => {
	const pr = parsePrCreate(`cd ~/work/x && gh pr create --base=main -H 'me:feat/y' --repo owner/x --body-file "/srv/b.md"`);
	assert.deepEqual(pr, { cdDir: `${homedir()}/work/x`, base: 'main', head: 'me:feat/y', repo: 'owner/x', bodyFile: '/srv/b.md' });
	assert.deepEqual(parsePrCreate('gh pr create --title t'), { cdDir: undefined, base: undefined, head: undefined, repo: undefined, bodyFile: undefined });
});

test('a skip needs `Docs: none` and a reason', () => {
	assert.equal(docsSkipReason('Summary\nDocs: none — typo fix\n'), 'typo fix');
	assert.equal(docsSkipReason('docs: NONE - the Log is in another repository'), 'the Log is in another repository');
	assert.equal(docsSkipReason(`gh pr create --body "Docs: none — one-line body" --base main`), 'one-line body');
	assert.equal(docsSkipReason('Docs: none —   '), undefined);
	assert.equal(docsSkipReason('Docs: none'), undefined);
	assert.equal(docsSkipReason('Docs: updated'), undefined);
});

test('a Log is a kept file under a logs glob; a deleted Log and a file elsewhere are not', () => {
	const globs = ['docs/logs/**/*.md'];
	assert.deepEqual(judge([{ path: 'src/a.ts', status: 'M' }, { path: 'docs/logs/2026/x.md', status: 'A' }], globs), { ok: true, logs: ['docs/logs/2026/x.md'] });
	assert.deepEqual(judge([{ path: 'docs/logs/x.md', status: 'M' }], globs), { ok: true, logs: ['docs/logs/x.md'] });
	assert.equal(judge([{ path: 'docs/logs/x.md', status: 'D' }], globs).ok, false);
	assert.equal(judge([{ path: 'notes/logs/x.md', status: 'A' }, { path: 'docs/logs/x.txt', status: 'A' }], globs).ok, false);
	assert.equal(judge([{ path: 'changes/x.md', status: 'A' }], ['docs/logs/**/*.md', 'changes/*.md']).ok, true);
});

const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, '-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args], { encoding: 'utf8' });

function write(root: string, path: string, text: string) {
	mkdirSync(dirname(join(root, path)), { recursive: true });
	writeFileSync(join(root, path), text);
}

/** A repository with the docs Module on, `main` committed, and `feat/x` checked out with a code change. */
function repoOnBranch(kalfaYaml = 'schema: 1\nmodules: [docs]\n'): string {
	const root = gitRepo({ 'kalfa.yaml': kalfaYaml, '.gitignore': '.kalfa/\n', 'src/a.ts': 'a\n', 'docs/logs/old.md': 'old\n' });
	git(root, 'add', '.');
	git(root, 'commit', '-q', '-m', 'base');
	git(root, 'branch', '-M', 'main');
	git(root, 'checkout', '-q', '-b', 'feat/x');
	write(root, 'src/a.ts', 'b\n');
	git(root, 'commit', '-q', '-am', 'change');
	return root;
}

const before = (cwd: string, command: string): CoreEvent => ({ name: 'command.before', harness: 'fake', cwd, command });
const gate = (root: string, command: string, cwd = root) => docsModule.handlers['command.before'](before(cwd, command), { ...handlerContext(undefined), project: loadProject(cwd) });

test('the gate refuses a PR without a Log and says how to pass', () => {
	const root = repoOnBranch();
	const result = gate(root, 'gh pr create --fill');
	assert.match(result?.block ?? '', /Definition of Done is not met \(main\.\.\.HEAD\): no Log was added or changed \(a Log is a file under docs\/logs\/\*\*\/\*\.md\)/);
	assert.match(result?.block ?? '', /kalfa docs draft/);
	assert.match(result?.block ?? '', /Docs: none — <reason>/);
	assert.equal(gate(root, 'gh pr view 3'), undefined);
});

test('the gate allows a branch with a Log, an edited one too, and judges commits, not the work tree', () => {
	const root = repoOnBranch();
	write(root, 'docs/logs/new.md', 'new\n');
	assert.ok(gate(root, 'gh pr create --fill')?.block, 'an uncommitted Log does not count');
	git(root, 'add', 'docs/logs/new.md');
	git(root, 'commit', '-q', '-m', 'log');
	assert.equal(gate(root, 'gh pr create --fill'), undefined);

	const edited = repoOnBranch();
	write(edited, 'docs/logs/old.md', 'old, and a follow-up\n');
	git(edited, 'commit', '-q', '-am', 'follow-up');
	assert.equal(gate(edited, 'gh pr create --fill'), undefined);

	const deleted = repoOnBranch();
	git(deleted, 'rm', '-q', 'docs/logs/old.md');
	git(deleted, 'commit', '-q', '-m', 'drop');
	assert.ok(gate(deleted, 'gh pr create --fill')?.block);
});

test('the gate reads the logs globs and the base from the settings, and --base from the command', () => {
	const root = repoOnBranch('schema: 1\nmodules: [docs]\nsettings:\n  docs:\n    logs: [changes/*.md]\n    base: trunk\n');
	assert.match(gate(root, 'gh pr create --fill')?.block ?? '', /could not check this branch: git has no ref "trunk" or "origin\/trunk"/);
	write(root, 'changes/x.md', 'x\n');
	git(root, 'add', 'changes/x.md');
	git(root, 'commit', '-q', '-m', 'log');
	assert.equal(gate(root, 'gh pr create --base main --fill'), undefined);
});

test('a `Docs: none` line skips the gate, on the command line or in the body file', () => {
	const root = repoOnBranch();
	assert.deepEqual(gate(root, 'gh pr create --title t --body "Docs: none — a CI fix"'), { notice: 'kalfa docs: Definition of Done skipped: a CI fix' });
	write(root, 'body.md', 'Summary.\n\nDocs: none — tests only\n');
	assert.deepEqual(gate(root, 'gh pr create --body-file body.md'), { notice: 'kalfa docs: Definition of Done skipped: tests only' });
});

test('the gate judges the repository a `cd` names, and does nothing where the Module is off', () => {
	const root = repoOnBranch();
	const other = gitRepo({ 'kalfa.yaml': 'schema: 1\nmodules: []\n' });
	assert.equal(gate(root, 'gh pr create --fill', other), undefined, 'the Module is off here');
	assert.ok(gate(root, `cd ${root} && gh pr create --fill`, other)?.block, 'the cd names a repository with the Module on');
	assert.equal(gate(root, `cd ${other} && gh pr create --fill`, root), undefined);
	const plain = gitRepo();
	assert.equal(gate(plain, 'gh pr create --fill'), undefined, 'no kalfa.yaml');
});

test('--repo that is not the origin is not checked, and says so', () => {
	const root = repoOnBranch();
	git(root, 'remote', 'add', 'origin', 'git@github.com:owner/this.git');
	assert.ok(gate(root, 'gh pr create --repo owner/this --fill')?.block);
	assert.deepEqual(gate(root, 'gh pr create --repo owner/other --fill'), { notice: 'kalfa docs: not checked; --repo owner/other is not this repository\'s origin (owner/this).' });
});

test('the draft puts the Task Record in page order: Sections, then Memory candidates (the old part name too) and Next', async () => {
	const root = repoOnBranch();
	const env = { HOME: tempDir() };
	const adapters = new Map([['fake', fakeAdapter]]);
	const reg = registry(coreModule, docsModule);
	await taskCommand(adapters, reg).run(['start', '--done-when', 'it works', 'Build the docs Module'], captureIo(root, env));
	await sectionCommand(adapters, reg).run(['close', 'The gate'], captureIo(root, env, '**Done:** The gate refuses a PR without a Log.\n\n**Found:** git diff base...head holds the PR.\n\n**Lesson candidates:** A test proves only the inputs it runs.\n\n**Next:** the draft.\n'));
	await sectionCommand(adapters, reg).run(['close', 'The draft'], captureIo(root, env, '**Done:** The draft.\n\n**Decisions:** No overwrite.\n\n**Next:** open the PR.\n'));
	const record = readRecord(root, 'feat-x')!;
	assert.equal(
		logDraft(record, '2026-10-27'),
		[
			'---',
			'title: "Build the docs Module"',
			'type: log',
			'date: 2026-10-27',
			'---',
			'',
			'<!-- Draft from the kalfa Task Record feat-x.md: edit it into the Log style of this site, and cut what a later reader does not need. -->',
			'',
			'## The gate',
			'',
			'The gate refuses a PR without a Log.',
			'',
			'**Found:** git diff base...head holds the PR.',
			'',
			'## The draft',
			'',
			'The draft.',
			'',
			'**Decisions:** No overwrite.',
			'',
			'## Memory candidates',
			'',
			'A test proves only the inputs it runs.',
			'',
			'## Next',
			'',
			'open the PR.',
			'',
		].join('\n'),
	);
	assert.equal(slugOf('Fix the push rule!'), 'fix-the-push-rule');
	assert.equal(slugOf('***'), 'task');
});

test('kalfa docs draft writes into a folder, never over a page; kalfa docs check judges the branch', async () => {
	const root = repoOnBranch();
	const env = { HOME: tempDir() };
	const adapters = new Map([['fake', fakeAdapter]]);
	const command = docsCommand(() => '2026-10-27');
	await taskCommand(adapters, registry(coreModule)).run(['start', '--done-when', 'it works', 'Build the docs Module'], captureIo(root, env));
	await sectionCommand(adapters, registry(coreModule)).run(['close', 'The gate'], captureIo(root, env, '**Done:** a.\n'));

	let io = captureIo(root, env);
	assert.equal(await command.run(['check'], io), 1);
	assert.match(io.stderr.join('\n'), /not met \(main\.\.\.HEAD\)/);

	io = captureIo(root, env);
	assert.equal(await command.run(['draft'], io), 0);
	assert.match(io.stdout.join('\n'), /^---\ntitle: "Build the docs Module"/);

	io = captureIo(root, env);
	assert.equal(await command.run(['draft', '--out', 'docs/logs/'], io), 0);
	const file = join(root, 'docs/logs/2026-10-27-build-the-docs-module.md');
	assert.match(readFileSync(file, 'utf8'), /## The gate\n\na\./);
	assert.deepEqual(io.stderr, []);
	await assert.rejects(command.run(['draft', '--out', 'docs/logs'], captureIo(root, env)), /exists; kalfa docs draft does not overwrite a page/);

	io = captureIo(root, env);
	assert.equal(await command.run(['draft', '--out', 'notes/log.md'], io), 0);
	assert.match(io.stderr.join('\n'), /notes\/log\.md is not under docs\/logs\/\*\*\/\*\.md/);
	rmSync(join(root, 'notes'), { recursive: true });

	git(root, 'add', 'docs/logs');
	git(root, 'commit', '-q', '-m', 'log');
	io = captureIo(root, env);
	assert.equal(await command.run(['check'], io), 0);
	assert.deepEqual(io.stdout, ['Definition of Done met (main...HEAD): Log docs/logs/2026-10-27-build-the-docs-module.md.']);

	const off = gitRepo({ 'kalfa.yaml': 'schema: 1\nmodules: []\n' });
	await assert.rejects(command.run(['check'], captureIo(off, env)), /the docs Module is not on/);
});

test('at a Task close the agent is told the Log is due, and how to draft it', async () => {
	const root = repoOnBranch();
	const result = await docsModule.handlers['task.close']({ name: 'task.close', harness: 'fake', cwd: root, task: 'feat-x', record: '/r' }, { ...handlerContext(undefined), project: loadProject(root) });
	assert.match(result?.context ?? '', /Task feat-x needs a Log before its PR, a file under docs\/logs\/\*\*\/\*\.md/);
	assert.match(result?.context ?? '', /kalfa docs draft --task feat-x --out <dir>/);
});
