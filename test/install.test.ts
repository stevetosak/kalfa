import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { claudeAdapter } from '../src/adapters/claude/adapter.ts';
import { claudeUser } from '../src/adapters/claude/user.ts';
import { installCommand, uninstallCommand } from '../src/cli/commands/install.ts';
import { KalfaError } from '../src/core/errors.ts';
import { captureIo, tempRepo } from './helpers.ts';

const modulesDir = tempRepo({
	'guardrails/module.yaml': "schema: 1\ndescription: Hard rules.\ncommands:\n  ask: ['git clean *', 'git restore *']\n",
});
const pkg = tempRepo({ 'package.json': '{}\n', 'dist/kalfa-hook': '', 'dist/adapters/claude/status-tap': '' });
const shim = join(pkg, 'dist/kalfa-hook');
const tap = join(pkg, 'dist/adapters/claude/status-tap');
const adapters = new Map([['claude', claudeAdapter]]);
const install = installCommand(adapters, () => modulesDir, () => pkg);
const uninstall = uninstallCommand(adapters);

const FOREIGN = { matcher: 'Bash', hooks: [{ type: 'command', command: 'operator-own-hook', timeout: 5 }] };
const OPERATOR = {
	model: 'opus',
	statusLine: { type: 'command', command: '~/.claude/statusline.sh --short' },
	permissions: { allow: ['Bash(ls)'], ask: ['Bash(git restore *)'] },
	hooks: { PreToolUse: [FOREIGN], Notification: [{ hooks: [{ type: 'command', command: 'notify-me' }] }] },
};

function machine(settings: unknown, modules = '[guardrails]'): string {
	const files: Record<string, string> = { '.config/kalfa/config.yaml': `schema: 1\nmodules: ${modules}\n` };
	if (settings !== undefined) files['.claude/settings.json'] = JSON.stringify(settings);
	return tempRepo(files);
}

async function run(command: typeof install, home: string, ...args: string[]) {
	const io = captureIo(home, { HOME: home });
	const code = await command.run(args, io);
	return { code, out: io.stdout.join('\n') };
}

const settings = (home: string) => JSON.parse(readFileSync(join(home, '.claude/settings.json'), 'utf8'));
const backups = (home: string) => readdirSync(join(home, '.claude')).filter((name) => name.startsWith('settings.json.bak-kalfa-'));

test('install adds a hook per Core event, wraps the status line and adds the approvals, and keeps everything else', async () => {
	const home = machine(OPERATOR);
	const first = await run(install, home);
	assert.equal(first.code, 0);
	const after = settings(home);
	assert.equal(after.model, 'opus');
	assert.deepEqual(after.hooks.PreToolUse[0], FOREIGN, 'the foreign hook stays first');
	assert.deepEqual(after.hooks.PreToolUse[1], { matcher: 'Bash', hooks: [{ type: 'command', command: `${shim} claude command.before`, timeout: 10 }] });
	assert.deepEqual(after.hooks.Notification, OPERATOR.hooks.Notification);
	for (const [hook, event] of [['SessionStart', 'session.start'], ['UserPromptSubmit', 'prompt.submit'], ['PostToolUse', 'tool.after']] as const) {
		assert.deepEqual(after.hooks[hook], [{ hooks: [{ type: 'command', command: `${shim} claude ${event}`, timeout: 10 }] }], hook);
	}
	assert.equal(after.statusLine.command, `${tap} ~/.claude/statusline.sh --short`);
	assert.deepEqual(after.permissions, { allow: ['Bash(ls)'], ask: ['Bash(git restore *)', 'Bash(git clean *)'] });
	assert.equal(backups(home).length, 1);
	assert.ok(existsSync(join(home, '.config/kalfa/install.yaml')));

	const second = await run(install, home);
	assert.match(second.out, /nothing to change/);
	assert.equal(backups(home).length, 1, 'no backup when nothing changes');
});

test("install takes over hand-written kalfa hooks without a second copy, and uninstall leaves the Operator's settings", async () => {
	const hand = { matcher: '^(startup|resume)$', hooks: [{ type: 'command', command: "'/old place/kalfa-hook' claude session.start", timeout: 10 }] };
	const before = { ...OPERATOR, hooks: { ...OPERATOR.hooks, SessionStart: [{ hooks: [{ type: 'command', command: 'herdr-state' }] }, hand] } };
	const home = machine(before);
	await run(install, home);
	const sessionStart = settings(home).hooks.SessionStart;
	assert.equal(sessionStart.length, 2);
	assert.equal(sessionStart[0].hooks[0].command, 'herdr-state');
	assert.equal(sessionStart[1].hooks[0].command, `${shim} claude session.start`);

	const removed = await run(uninstall, home);
	assert.equal(removed.code, 0);
	const left = settings(home);
	// The hand-written kalfa hook is kalfa's too, so it goes; the Operator's approval that a Module also wants stays.
	assert.deepEqual(left, { ...OPERATOR, hooks: { ...OPERATOR.hooks, SessionStart: [{ hooks: [{ type: 'command', command: 'herdr-state' }] }] } });
	assert.ok(!existsSync(join(home, '.config/kalfa/install.yaml')));
});

test('install then uninstall gives back the same settings content', async () => {
	const home = machine(OPERATOR);
	await run(install, home);
	await run(uninstall, home);
	assert.deepEqual(settings(home), OPERATOR);
});

test('without a settings file, install writes one, and uninstall leaves it empty', async () => {
	const home = machine(undefined, '[]');
	await run(install, home);
	assert.equal(settings(home).statusLine.command, tap);
	assert.equal(backups(home).length, 0);
	await run(uninstall, home);
	assert.deepEqual(settings(home), {});
});

test('a dry run writes nothing', async () => {
	const home = machine(OPERATOR);
	const out = await run(install, home, '--dry-run');
	assert.match(out.out, /dry run: nothing was written/);
	assert.deepEqual(settings(home), OPERATOR);
	assert.ok(!existsSync(join(home, '.config/kalfa/install.yaml')));
});

test('a status line with a shell operator is refused, and nothing is written', async () => {
	const home = machine({ statusLine: { type: 'command', command: 'git branch | head -1' } });
	await assert.rejects(run(install, home), (error: Error) => error instanceof KalfaError && /shell operator/.test(error.message));
	assert.deepEqual(settings(home), { statusLine: { type: 'command', command: 'git branch | head -1' } });
});

test('the Claude user layout knows a quoted shim and a quoted tap as kalfa\'s', () => {
	const data = { hooks: { Stop: [{ hooks: [{ type: 'command', command: '"/a b/kalfa-hook" claude task.close' }] }] }, statusLine: { type: 'command', command: "'/a b/status-tap' own-line" } };
	assert.deepEqual(claudeUser.hooks(data, undefined), { statusLine: data.statusLine });
	assert.deepEqual(claudeUser.statusLine!(data, undefined), { ...data, statusLine: { type: 'command', command: 'own-line' } });
	assert.equal(claudeUser.hooks({ model: 'x' }, undefined).model, 'x');
	const same = { model: 'x' };
	assert.equal(claudeUser.hooks(same, undefined), same, 'unchanged data is the same object');
});
