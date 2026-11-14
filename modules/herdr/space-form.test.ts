import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { claudeAdapter } from '../../src/adapters/claude/adapter.ts';
import { readRecord } from '../../src/core/task-record.ts';
import { captureIo } from '../../test/helpers.ts';
import { cloned, fakeHerdr, git, machine } from '../../test/space-fixtures.ts';
import { spaceCommand } from './command.ts';
import type { Choice, Prompter } from './prompter.ts';
import { prepareWorktree } from './space.ts';
import { spaceOpenCommand } from './space-form.ts';

/** Take the question's default: the select default, the first search match, the input default. */
const DEFAULT = Symbol('default');
type Answer = string | boolean | typeof DEFAULT;

interface Asked {
	message: string;
	choices?: string[];
	default?: unknown;
}

/** A Prompter that gives set answers in order, checks inputs like the terminal, and records each question. */
function scripted(answers: Answer[]) {
	const asked: Asked[] = [];
	const next = (message: string) => {
		if (!answers.length) throw new Error(`no answer left for "${message}"`);
		return answers.shift()!;
	};
	const pick = <T>(message: string, choices: readonly Choice<T>[], fallback: T | undefined): T => {
		asked.push({ message, choices: choices.map((c) => c.name), default: fallback });
		const answer = next(message);
		if (answer === DEFAULT) return fallback !== undefined ? fallback : choices[0]!.value;
		const found = choices.find((c) => c.name === answer);
		if (!found) throw new Error(`"${message}": no choice "${String(answer)}" in ${choices.map((c) => c.name).join(', ')}`);
		return found.value;
	};
	const prompter: Prompter = {
		async input(message, options = {}) {
			asked.push({ message, default: options.default });
			const answer = next(message);
			const value = answer === DEFAULT ? (options.default ?? '') : String(answer);
			const check = options.validate?.(value) ?? true;
			if (check !== true) throw new Error(`"${message}" refused "${value}": ${check}`);
			return value;
		},
		select: async (message, choices, options = {}) => pick(message, choices, options.default),
		search: async (message, choices) => pick(message, choices, undefined),
		async confirm(message, options = {}) {
			asked.push({ message, default: options.default });
			const answer = next(message);
			return answer === DEFAULT ? (options.default ?? false) : answer === true;
		},
	};
	return { prompter, asked, left: answers };
}

const PLAN = '---\ntitle: "Side work"\ntype: plan\nstatus: active\n---\n\n**Done when:** done.\n\n- [ ] A step.\n';
const presets = { 'default-preset': 'pair', presets: { solo: [{ agent: 'claude' }], pair: [{ agent: 'claude' }, { agent: 'claude', label: 'review', model: 'haiku' }, { label: 'git', run: 'lazygit' }] } };

function setup() {
	const repo = cloned({ 'kalfa.yaml': 'schema: 1\nplans: [docs/plan-*.md]\n', 'docs/plan-side.md': PLAN });
	const env = { ...machine({ ...presets, 'space-dirs': [repo.dir] }), HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({ workspace_cwd: repo.main }) };
	return { ...repo, env };
}

async function form(answers: Answer[], env: NodeJS.ProcessEnv, workspaces: { workspace_id: string; label: string }[] = [], flags: string[] = []) {
	const script = scripted(answers);
	const herdr = fakeHerdr(workspaces);
	const io = captureIo('/', env);
	const code = await spaceCommand(new Map([['claude', claudeAdapter]]), { exec: herdr.exec, prompter: script.prompter }).run(['new', ...flags], io);
	return { ...script, herdr, io, code, starts: herdr.calls.filter((c) => c[0] === 'agent' && c[1] === 'start') };
}

test('space new with the defaults: the plugin Workspace repository, a new Task on the only active Plan from origin\'s default branch, the default Preset, the successor prompt', async () => {
	const { dir, main, env } = setup();
	const run = await form([DEFAULT, DEFAULT, 'feat/side', 'Side work', 'it works', DEFAULT, DEFAULT, DEFAULT, DEFAULT, DEFAULT, DEFAULT, DEFAULT], env);
	assert.equal(run.code, 0);
	assert.deepEqual(run.left, [], 'every answer was asked for');
	const messages = run.asked.map((q) => q.message.replace(/origin\/(main|master)/, 'origin/<default>'));
	assert.deepEqual(messages, [
		'Repository',
		'What to open',
		'Branch',
		'Goal',
		'Done when',
		'Plan',
		'Base branch (default: origin/<default>)',
		'Preset',
		'Model of agent tab "claude" (empty: the harness\'s default)',
		'Model of agent tab "review" (empty: the harness\'s default)',
		'First prompt of the first agent tab',
		'Open this space?',
	]);
	assert.deepEqual(run.asked[1]!.choices, ['New Task', 'Workspace only'], 'no open Task: no Open Task mode');
	assert.equal(run.asked[5]!.default, 'docs/plan-side.md', 'the only active Plan is the default');

	assert.equal(readRecord(main, 'feat-side')?.header.plan, 'docs/plan-side.md');
	assert.equal(run.io.stdout[0], `The same with flags:\n  kalfa space open ${main} --task feat/side 'Side work' --done-when 'it works' --plan docs/plan-side.md --preset pair`);
	assert.match(run.starts[0]!.at(-1)!, /Continue the kalfa Task feat-side/);
	assert.deepEqual(run.starts[1]!.slice(run.starts[1]!.indexOf('--') + 1), ['-n', 'feat-side review', '--model', 'haiku']);
	assert.ok(run.herdr.calls.filter((c) => c[1] === 'create').every((c) => c.includes(join(dir, 'proj.worktrees', 'feat-side'))));
});

test('space new with changed values: no Plan, another base, a model per tab and my own prompt; the shown command opens the same space', async () => {
	const { main, origin, env } = setup();
	git(origin, 'branch', 'release', 'HEAD');
	const answers: Answer[] = ['proj', 'New Task', 'feat/rel', 'Fix the release', 'release builds', 'No Plan', 'origin/release', 'pair', 'opus', 'sonnet', 'My own text', "Read the release's notes", true];
	const run = await form(answers, env);
	const command = `kalfa space open ${main} --task feat/rel 'Fix the release' --done-when 'release builds' --base origin/release --preset pair --model claude=opus --model review=sonnet --prompt 'Read the release'\\''s notes'`;
	assert.equal(run.io.stdout[0], `The same with flags:\n  ${command}`);
	assert.equal(readRecord(main, 'feat-rel')?.header.plan, undefined);
	assert.deepEqual(
		run.starts.map((c) => c.slice(c.indexOf('--') + 1)),
		[['-n', 'feat-rel', '--model', 'opus', "Read the release's notes"], ['-n', 'feat-rel review', '--model', 'sonnet']],
	);
	assert.match(run.io.stdout.join('\n'), /new branch feat\/rel from origin\/release/);
});

test('space new on an open Task: the Task is chosen from the open ones, the Workspace mode opens no worktree, and a no keeps everything closed', async () => {
	const { main, env } = setup();
	await form([DEFAULT, DEFAULT, 'feat/side', 'Side work', 'it works', DEFAULT, DEFAULT, 'solo', DEFAULT, DEFAULT, false], env);
	assert.equal(readRecord(main, 'feat-side'), undefined, 'a no at the confirm opens nothing');

	prepareWorktree(main, 'feat/side');
	const started = await form([DEFAULT, DEFAULT, 'feat/side', 'Side work', 'it works', DEFAULT, DEFAULT, 'solo', DEFAULT, DEFAULT, true], env);
	assert.match(started.io.stdout.join('\n'), /Task feat-side started/);

	const reopened = await form([DEFAULT, 'Open Task', 'feat-side', 'solo', DEFAULT, 'No prompt', true], env);
	assert.deepEqual(reopened.asked[1]!.choices, ['New Task', 'Open Task', 'Workspace only']);
	assert.equal(reopened.io.stdout[0], `The same with flags:\n  kalfa space open ${main} --task feat/side --preset solo --no-prompt`);
	assert.equal(reopened.starts[0]!.at(-1), 'feat-side', 'no prompt');

	const workspace = await form([DEFAULT, 'Workspace only', 'solo', DEFAULT, DEFAULT, true], env, [{ workspace_id: 'w3', label: 'proj' }]);
	assert.deepEqual(workspace.asked.at(-2)!.choices, ['No prompt', 'My own text'], 'no Task: no successor prompt');
	assert.equal(workspace.io.stdout[0], `The same with flags:\n  kalfa space open ${main} --preset solo`);
	assert.ok(workspace.herdr.calls.some((c) => c[0] === 'tab' && c[1] === 'create' && c.includes(main)), 'the Preset tab opens in the main checkout');
});

test('space new refuses a bad branch name and takes no arguments; the command line quotes only what needs it', async () => {
	const { env } = setup();
	await assert.rejects(form([DEFAULT, DEFAULT, 'bad..branch'], env), /not a valid branch name/);
	const script = scripted([]);
	await assert.rejects(spaceCommand(new Map(), { prompter: script.prompter }).run(['new', 'proj'], captureIo('/', env)), /does not take positional arguments/);
	assert.equal(spaceOpenCommand({ main: '/home/x/my repo' }, { HOME: '/home/x' }), "kalfa space open '~/my repo'");
	assert.equal(spaceOpenCommand({ main: '/home/x/repo' }, { HOME: '/home/x' }), 'kalfa space open ~/repo');
});

test('space new --mode: new asks no mode; open offers an open Task or the Workspace; --hold-on-error keeps an error until Enter', async () => {
	const { main, env } = setup();
	const fresh = await form([DEFAULT, 'feat/side', 'Side work', 'it works', DEFAULT, DEFAULT, 'solo', DEFAULT, DEFAULT, true], env, [], ['--mode', 'new']);
	assert.ok(!fresh.asked.some((q) => q.message === 'What to open'));
	assert.ok(readRecord(main, 'feat-side'));

	const open = await form([DEFAULT, DEFAULT, DEFAULT, DEFAULT, DEFAULT, DEFAULT, DEFAULT, false], env, [], ['--mode', 'open']);
	assert.deepEqual(open.asked[1]!.choices, ['Open Task', 'Workspace only']);
	assert.equal(open.asked[2]!.message, 'Task');

	const held = await form([DEFAULT, 'bad..branch', DEFAULT], env, [], ['--mode', 'new', '--hold-on-error']);
	assert.equal(held.code, 1);
	assert.match(held.io.stderr.join('\n'), /kalfa space: .*not a valid branch name/);
	assert.equal(held.asked.at(-1)!.message, 'Press Enter to close');
	await assert.rejects(form([], env, [], ['--mode', 'later']), /--mode later: give new or open/);
});
