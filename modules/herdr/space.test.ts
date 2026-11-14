import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { claudeAdapter } from '../../src/adapters/claude/adapter.ts';
import { UsageError } from '../../src/cli/command.ts';
import { DEFAULT_SETTINGS } from '../../src/core/settings.ts';
import { readRecord } from '../../src/core/task-record.ts';
import { captureIo, gitRepo, tempDir } from '../../test/helpers.ts';
import { spaceCommand } from './command.ts';
import { prepareWorktree, resolveRepo, spaceSettings, tabTitle } from './space.ts';

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { stdio: 'ignore' });

/** `<dir>/origin.git` and its clone `<dir>/proj` (main checkout), with kalfa.yaml and the .kalfa/ ignore. */
function cloned() {
	const seed = realpathSync(gitRepo({ 'kalfa.yaml': 'schema: 1\n', '.gitignore': '.kalfa/\n' }));
	git(seed, 'add', 'kalfa.yaml', '.gitignore');
	git(seed, 'commit', '-q', '-m', 'init');
	const dir = realpathSync(tempDir());
	execFileSync('git', ['clone', '-q', '--bare', seed, join(dir, 'origin.git')]);
	execFileSync('git', ['clone', '-q', join(dir, 'origin.git'), join(dir, 'proj')]);
	return { dir, main: join(dir, 'proj'), origin: join(dir, 'origin.git') };
}

/** A fake herdr: records each call and answers like Herdr 0.9. */
function fakeHerdr(workspaces: { workspace_id: string; label: string }[] = []) {
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

function machine(herdr: unknown) {
	const config = tempDir();
	mkdirSync(join(config, 'kalfa'), { recursive: true });
	writeFileSync(join(config, 'kalfa/config.yaml'), JSON.stringify({ schema: 1, modules: ['herdr'], settings: { herdr } }));
	return { HOME: tempDir(), XDG_CONFIG_HOME: config };
}

const presets = { 'default-preset': 'dev', presets: { dev: [{ agent: 'claude' }, { label: 'git', run: 'lazygit' }] } };

test('Presets live in the machine settings only, and are checked', () => {
	const project = { root: '/r', file: { schema: 1, modules: [], plans: [], settings: { herdr: { presets: {} } } } } as never;
	assert.throws(() => spaceSettings(DEFAULT_SETTINGS, project), /Presets are personal/);
	assert.throws(() => spaceSettings({ ...DEFAULT_SETTINGS, settings: { herdr: { 'default-preset': 'x' } } }, undefined), /default-preset names no Preset/);
	assert.throws(() => spaceSettings({ ...DEFAULT_SETTINGS, settings: { herdr: { presets: { dev: [{ run: 'lazygit' }] } } } }, undefined), /settings\.herdr/);
	assert.equal(tabTitle({ agent: 'claude' }, 'proj'), 'proj');
	assert.equal(tabTitle({ agent: 'claude' }, 'proj', 'feat-x'), 'feat-x');
	assert.equal(tabTitle({ run: 'lazygit', label: 'git' }, 'proj', 'feat-x'), 'feat-x git');
});

test('a repository is a path or a bare name in space-dirs, and always its main checkout', () => {
	const { dir, main } = cloned();
	assert.equal(resolveRepo('proj', '/', [dir], {}), main);
	assert.equal(resolveRepo('./proj', dir, [], {}), main);
	assert.throws(() => resolveRepo('nope', '/', [dir], {}), /no repository 'nope'/);
	const { path } = prepareWorktree(main, 'feat/side');
	assert.equal(resolveRepo(path, '/', [], {}), main, 'a worktree path gives the main checkout');
});

test('a Task worktree: a new branch from the remote default, an existing one reused, a remote branch tracked', () => {
	const { dir, main, origin } = cloned();
	const made = prepareWorktree(main, 'feat/new');
	assert.equal(made.path, join(dir, 'proj.worktrees', 'feat-new'));
	assert.match(made.note, /new branch feat\/new from origin\/(main|master)/);
	assert.match(prepareWorktree(main, 'feat/new').note, /exists: using it/);

	git(origin, 'branch', 'feat/remote', 'HEAD');
	assert.match(prepareWorktree(main, 'feat/remote').note, /tracking origin\/feat\/remote/);
});

test('space open: a new Workspace gets the Preset; an open one is only focused, unless --preset is given', async () => {
	const { dir, main } = cloned();
	const env = machine({ ...presets, 'space-dirs': [dir] });
	const fresh = fakeHerdr();
	await spaceCommand(new Map([['claude', claudeAdapter]]), { exec: fresh.exec }).run(['open', 'proj'], captureIo('/', env));
	assert.deepEqual(fresh.calls.find((c) => c[0] === 'workspace' && c[1] === 'create'), ['workspace', 'create', '--cwd', main, '--label', 'proj', '--no-focus']);
	assert.ok(fresh.calls.some((c) => c[0] === 'agent' && c[1] === 'start' && c.at(-1) === 'proj'), 'the agent waits for the Operator: no prompt');
	assert.ok(fresh.calls.some((c) => c.join(' ') === 'pane run p2 lazygit'));

	const open = fakeHerdr([{ workspace_id: 'w3', label: 'proj' }]);
	const io = captureIo('/', env);
	await spaceCommand(new Map([['claude', claudeAdapter]]), { exec: open.exec }).run(['open', 'proj'], io);
	assert.match(io.stdout.join('\n'), /Workspace proj \(w3\) is open: .*no tabs added/);
	assert.ok(!open.calls.some((c) => c[1] === 'create'));

	const again = fakeHerdr([{ workspace_id: 'w3', label: 'proj' }]);
	await spaceCommand(new Map([['claude', claudeAdapter]]), { exec: again.exec }).run(['open', 'proj', '--preset', 'dev'], captureIo('/', env));
	assert.equal(again.calls.filter((c) => c[0] === 'tab' && c[1] === 'create' && c[3] === 'w3').length, 2);
});

test('space open --task: worktree, branch and Task Record in the main checkout; only the first agent continues the Task', async () => {
	const { dir, main } = cloned();
	const env = machine({ presets: { pair: [{ agent: 'claude' }, { agent: 'claude', label: 'review' }] }, 'space-dirs': [dir] });
	const space = (exec: (args: string[]) => string, ...args: string[]) => spaceCommand(new Map([['claude', claudeAdapter]]), { exec }).run(['open', 'proj', ...args], captureIo('/', env));

	await assert.rejects(space(fakeHerdr().exec, '--task', 'feat/x', '--preset', 'pair'), (e) => e instanceof UsageError && /give its goal and --done-when/.test(e.message));
	const herdr = fakeHerdr([{ workspace_id: 'w3', label: 'proj' }]);
	await space(herdr.exec, '--task', 'feat/x', 'Side work', '--done-when', 'it works', '--preset', 'pair');
	assert.equal(readRecord(main, 'feat-x')?.header.branch, 'feat/x');
	const starts = herdr.calls.filter((c) => c[0] === 'agent' && c[1] === 'start');
	assert.equal(starts.length, 2);
	assert.match(starts[0]!.at(-1)!, /Continue the kalfa Task feat-x/);
	assert.equal(starts[1]!.at(-1), 'feat-x review', 'the second agent starts without the Task prompt');
	assert.ok(herdr.calls.filter((c) => c[1] === 'create').every((c) => c.includes(join(dir, 'proj.worktrees', 'feat-x'))));

	const reopened = fakeHerdr([{ workspace_id: 'w3', label: 'proj' }]);
	await space(reopened.exec, '--task', 'feat/x', '--preset', 'pair');
	assert.equal(reopened.calls.filter((c) => c[0] === 'agent' && c[1] === 'start').length, 2, 'an open Task needs only --task');
});

test('space open --base: a new branch starts at the base (a local ref or a branch on origin); an existing branch ignores it', async () => {
	const { main, origin } = cloned();
	git(origin, 'branch', 'release', 'HEAD');
	const made = prepareWorktree(main, 'feat/b', undefined, 'release');
	assert.match(made.note, /new branch feat\/b from origin\/release/);
	assert.match(prepareWorktree(main, 'feat/b', undefined, 'release').note, /--base release is not used, the branch exists/);
	assert.throws(() => prepareWorktree(main, 'feat/c', undefined, 'nope'), /--base nope: no branch, tag or commit/);
});

test('space open --model and --prompt: models by tab key or for all; the first agent tab gets the prompt, or none', async () => {
	const { dir } = cloned();
	const env = machine({ presets: { pair: [{ agent: 'claude' }, { agent: 'claude', label: 'review', model: 'haiku' }] }, 'space-dirs': [dir] });
	const space = async (...args: string[]) => {
		const herdr = fakeHerdr();
		await spaceCommand(new Map([['claude', claudeAdapter]]), { exec: herdr.exec }).run(['open', 'proj', '--preset', 'pair', ...args], captureIo('/', env));
		return herdr.calls.filter((c) => c[0] === 'agent' && c[1] === 'start').map((c) => c.slice(c.indexOf('--') + 1));
	};

	assert.deepEqual(await space('--model', 'opus'), [['-n', 'proj', '--model', 'opus'], ['-n', 'review', '--model', 'opus']]);
	assert.deepEqual(await space('--model', 'claude=sonnet'), [['-n', 'proj', '--model', 'sonnet'], ['-n', 'review', '--model', 'haiku']], 'a tab key wins; other tabs keep their own model');
	await assert.rejects(space('--model', 'reveiw=opus'), /--model reveiw: no agent tab of that name/);

	assert.deepEqual(await space('--prompt', 'Look at the failing test'), [['-n', 'proj', 'Look at the failing test'], ['-n', 'review', '--model', 'haiku']]);
	await assert.rejects(space('--prompt', 'x', '--no-prompt'), /exclude each other/);

	const task = fakeHerdr();
	await spaceCommand(new Map([['claude', claudeAdapter]]), { exec: task.exec }).run(['open', 'proj', '--preset', 'pair', '--task', 'feat/q', 'Goal', '--done-when', 'done', '--no-prompt'], captureIo('/', env));
	const lead = task.calls.find((c) => c[0] === 'agent' && c[1] === 'start')!;
	assert.equal(lead.at(-1), 'feat-q', 'a Task with --no-prompt starts its agent on no prompt');
});

test('space open: an open Workspace that only gets focus refuses --model and --prompt; --base goes with --task', async () => {
	const { dir } = cloned();
	const env = machine({ ...presets, 'space-dirs': [dir] });
	const open = fakeHerdr([{ workspace_id: 'w3', label: 'proj' }]);
	await assert.rejects(spaceCommand(new Map([['claude', claudeAdapter]]), { exec: open.exec }).run(['open', 'proj', '--model', 'opus'], captureIo('/', env)), /only gets focus/);
	await assert.rejects(spaceCommand(new Map([['claude', claudeAdapter]]), { exec: open.exec }).run(['open', 'proj', '--base', 'main'], captureIo('/', env)), /go with --task/);
});
