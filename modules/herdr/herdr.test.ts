import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Adapter } from '../../src/adapters/adapter.ts';
import { claudeAdapter } from '../../src/adapters/claude/adapter.ts';
import { sectionCommand, taskCommand } from '../../src/cli/commands/task.ts';
import { coreModule } from '../../src/modules/core.ts';
import { fakeAdapter, handlerContext, registry } from '../../test/fakes.ts';
import { captureIo, gitRepo, tempDir } from '../../test/helpers.ts';
import { herdrCommand, LIMIT_EXIT } from './command.ts';
import { herdrModuleWith, integrationState } from './handlers.ts';
import { agentName, type HerdrExec, HerdrSetupError, herdrTab, START_TIMEOUT_MS } from './launcher.ts';
import { continueTask, defaultLauncher, type Launch, type Launcher } from './successor.ts';

const launch: Launch = { cwd: '/home/op/Projects/kalfa', name: 'feat-herdr-module', prompt: 'Continue the kalfa Task feat-herdr-module.' };

const answer = (result: unknown) => JSON.stringify({ id: 'cli', result });

/** A herdr that answers from a script and records every call; `fail` makes one verb throw. */
function fakeHerdr(options: { workspaces?: { workspace_id: string; label: string }[]; agents?: { name?: string }[]; fail?: Record<string, string> } = {}) {
	const calls: string[][] = [];
	const exec: HerdrExec = (args) => {
		calls.push(args);
		const verb = args.slice(0, 2).join(' ');
		const failure = options.fail?.[verb];
		if (failure) throw Object.assign(new Error('exit 1'), { stderr: failure });
		switch (verb) {
			case 'workspace list':
				return answer({ workspaces: options.workspaces ?? [{ workspace_id: 'w4', label: 'kalfa' }] });
			case 'workspace create':
				return answer({ workspace: { workspace_id: 'w9' }, tab: { tab_id: 'w9:t1' }, root_pane: { pane_id: 'w9:p1' } });
			case 'tab create':
				return answer({ tab: { tab_id: 'w4:t3' }, root_pane: { pane_id: 'w4:p7' } });
			case 'agent list':
				return answer({ agents: options.agents ?? [] });
			default:
				return answer({});
		}
	};
	return { exec, calls };
}

const tab = (exec: HerdrExec) => herdrTab('claude', claudeAdapter.session!, exec);

/** A folder with an executable `herdr`, for the PATH check. */
function fakeBinDir(): string {
	const dir = tempDir();
	writeFileSync(join(dir, 'herdr'), '#!/bin/sh\nexit 0\n');
	chmodSync(join(dir, 'herdr'), 0o755);
	return dir;
}

test('agent names fit Herdr and avoid live ones', () => {
	assert.equal(agentName('docs-site-task-list-task-rename-and-herdr-handover', new Set()), 'docs-site-task-list-task-rename');
	assert.equal(agentName('2026 Cloud Infra!', new Set()), 'cloud-infra');
	assert.equal(agentName('---', new Set()), 'next');
	assert.equal(agentName('kluster', new Set(['kluster', 'kluster-2'])), 'kluster-3');
	const long = 'a'.repeat(40);
	assert.equal(agentName(long, new Set(['a'.repeat(32)])), `${'a'.repeat(30)}-2`);
	for (const name of [agentName(long, new Set()), agentName('x y', new Set())]) assert.match(name, /^[a-z][a-z0-9_-]{0,31}$/);
});

test('a new tab in the project workspace, named after the Task, runs the harness on the prompt and gets focus', () => {
	const { exec, calls } = fakeHerdr({ agents: [{ name: 'feat-herdr-module' }, {}] });
	const out = tab(exec)({ ...launch, model: 'opus' });
	assert.deepEqual(calls[1], ['tab', 'create', '--workspace', 'w4', '--cwd', launch.cwd, '--label', launch.name, '--no-focus']);
	assert.deepEqual(calls[3], [
		'agent', 'start', 'feat-herdr-module-2', '--kind', 'claude', '--pane', 'w4:p7', '--timeout', String(START_TIMEOUT_MS),
		'--', '-n', launch.name, '--model', 'opus', launch.prompt,
	]);
	assert.deepEqual(calls.slice(4), [['workspace', 'focus', 'w4'], ['tab', 'focus', 'w4:t3']]);
	assert.match(out, /agent feat-herdr-module-2 \(claude\) .*w4:t3.*focus moved there/);
	assert.ok(!calls.flat().includes('--current'), 'never targets the inherited pane');
});

test('a project without a workspace gets one, labelled with the folder name, and its tab is renamed', () => {
	const { exec, calls } = fakeHerdr({ workspaces: [{ workspace_id: 'w3', label: 'cloud-infra' }] });
	tab(exec)(launch);
	assert.deepEqual(calls[1], ['workspace', 'create', '--cwd', launch.cwd, '--label', 'kalfa', '--no-focus']);
	assert.deepEqual(calls[2], ['tab', 'rename', 'w9:t1', launch.name]);
	assert.equal(calls[4]![6], 'w9:p1');
});

test('a step before agent start fails: a setup error, and agent start never runs', () => {
	const { exec, calls } = fakeHerdr({ fail: { 'tab create': '{"error":{"code":"workspace_not_found"}}' } });
	assert.throws(() => tab(exec)(launch), (e) => e instanceof HerdrSetupError && /workspace_not_found/.test(e.message));
	assert.ok(!calls.some((c) => c[0] === 'agent' && c[1] === 'start'));
});

test('a harness blocked at start (the trust prompt) is a started session: the tab is named, focus moves', () => {
	const { exec, calls } = fakeHerdr({ fail: { 'agent start': '{"error":{"code":"agent_not_ready"}}' } });
	const out = tab(exec)(launch);
	assert.match(out, /accept the trust prompt .* in that tab/);
	assert.match(out, /w4:t3/);
	assert.deepEqual(calls.at(-1), ['tab', 'focus', 'w4:t3']);
});

test('a failed focus is reported, not fatal', () => {
	const { exec } = fakeHerdr({ fail: { 'tab focus': 'no such tab' } });
	assert.match(tab(exec)(launch), /focus did not move \(no such tab\)/);
});

test('any other agent start error is not a setup error: a session may run, so nothing falls back', () => {
	const { exec } = fakeHerdr({ fail: { 'agent start': '{"error":{"code":"timeout"}}' } });
	let backgroundRan = false;
	const background: Launcher = () => ((backgroundRan = true), 'bg');
	const launcher = defaultLauncher(claudeAdapter, { HERDR_ENV: '1', PATH: fakeBinDir() }, tab(exec), background);
	assert.throws(() => launcher(launch), (e) => !(e instanceof HerdrSetupError) && /a session may run there/.test((e as Error).message));
	assert.equal(backgroundRan, false);
});

test('the launcher: Herdr only inside Herdr with herdr on PATH; a setup error falls back to a background session', () => {
	const herdr: Launcher = () => 'tab';
	const background: Launcher = () => 'bg';
	const bin = fakeBinDir();
	assert.equal(defaultLauncher(claudeAdapter, { PATH: bin }, herdr, background)(launch), 'bg');
	assert.equal(defaultLauncher(claudeAdapter, { HERDR_ENV: '1', PATH: '/nonexistent' }, herdr, background)(launch), 'bg');
	assert.equal(defaultLauncher(claudeAdapter, { HERDR_ENV: '1', PATH: bin }, herdr, background)(launch), 'tab');
	const broken: Launcher = () => {
		throw new HerdrSetupError('Herdr tab setup failed: x');
	};
	assert.match(defaultLauncher(claudeAdapter, { HERDR_ENV: '1', PATH: bin }, broken, background)(launch), /setup failed: x\nStarted in the background instead:\nbg/);
});

test('a harness without background sessions: outside Herdr the launcher says how to start one by hand', () => {
	const noBackground: Adapter = { ...fakeAdapter, session: { program: 'fake', interactive: ({ prompt }) => [prompt] } };
	assert.throws(() => defaultLauncher(noBackground, {})(launch), /not inside Herdr, and fake has no background sessions; start one in \/home\/op\/Projects\/kalfa on the prompt: Continue/);
	assert.throws(() => defaultLauncher(fakeAdapter, {}), /kalfa cannot start a fake session/);
});

test('Claude starts a named session on the prompt, interactive or in the background', () => {
	const session = claudeAdapter.session!;
	assert.deepEqual(session.interactive({ name: 'n', prompt: 'p' }), ['-n', 'n', 'p']);
	assert.deepEqual(session.background!({ name: 'n', prompt: 'p', model: 'opus' }), ['--bg', '-n', 'n', '--model', 'opus', 'p']);
});

test('continue starts the successor on the Task, unless a usage limit is near and it is not forced', () => {
	const launches: Launch[] = [];
	const launcher: Launcher = (l) => (launches.push(l), 'started');
	const near = () => ({ ok: false as const, reason: 'five_hour at 94%' });
	assert.deepEqual(continueTask({ task: 't1', cwd: '/r', launcher, limits: near }), { launched: false, reason: 'a usage limit is near: five_hour at 94%' });
	assert.equal(launches.length, 0);
	assert.deepEqual(continueTask({ task: 't1', cwd: '/r', launcher, limits: () => ({ ok: true, note: 'five_hour 10%' }) }), { launched: true, output: 'started', note: 'five_hour 10%' });
	assert.deepEqual(launches[0], { cwd: '/r', name: 't1', model: undefined, prompt: launches[0]!.prompt });
	assert.match(launches[0]!.prompt, /kalfa task show --handoff --task t1/);
	assert.match(continueTask({ task: 't1', cwd: '/r', launcher, force: true, limits: near }).launched ? 'ok' : '', /ok/);
});

test('kalfa herdr continue: the Module must be on, the Task open; exit 3 at a near limit', async () => {
	const adapters = new Map([['fake', { ...fakeAdapter, session: { program: 'fake', interactive: () => [] } }]]);
	const root = gitRepo({ 'kalfa.yaml': 'schema: 1\nmodules: [herdr]\n', '.gitignore': '.kalfa/\n' });
	execFileSync('git', ['-C', root, 'checkout', '-q', '-b', 'feat/x']);
	const env = { HOME: tempDir(), KALFA_FAKE_HARNESS: '1' };
	const launches: Launch[] = [];
	let verdict = { ok: true as boolean, note: 'five_hour 3%', reason: 'five_hour at 90%' };
	const command = herdrCommand(adapters, { launcher: () => (l) => (launches.push(l), 'Started agent x'), limits: () => (verdict.ok ? { ok: true, note: verdict.note } : { ok: false, reason: verdict.reason }) });

	await assert.rejects(command.run(['continue'], captureIo(root, env)), /no Task Record 'feat-x'/);
	await taskCommand(adapters, registry(coreModule)).run(['start', 'Build herdr'], captureIo(root, env));
	await sectionCommand(adapters, registry(coreModule)).run(['close', 'first'], captureIo(root, env, '**Done:** a.\n\n**Next:** b.\n'));

	let io = captureIo(root, env);
	assert.equal(await command.run(['continue', '--model', 'opus'], io), 0);
	assert.deepEqual(io.stdout, ['Started agent x', 'Usage: five_hour 3%.']);
	assert.deepEqual({ ...launches[0], prompt: '' }, { cwd: root, name: 'feat-x', model: 'opus', prompt: '' });

	verdict = { ...verdict, ok: false };
	io = captureIo(root, env);
	assert.equal(await command.run(['continue'], io), LIMIT_EXIT);
	assert.match(io.stderr[0]!, /a usage limit is near: five_hour at 90%\. Nothing started/);
	assert.equal(await command.run(['continue', '--force'], captureIo(root, env)), 0);

	const off = gitRepo({ 'kalfa.yaml': 'schema: 1\nmodules: []\n' });
	await assert.rejects(command.run(['continue'], captureIo(off, env)), /the herdr Module is not on in this repository/);
	await assert.rejects(command.run(['continue'], captureIo(root, { HOME: env.HOME })), /cannot tell which harness/);
});

test('at session start inside Herdr, a missing or old integration for the harness is a notice', async () => {
	const status = 'pi: current (v9) (/p)\nclaude: outdated (v8) (/c)\ncodex: not installed (/x)\n';
	assert.equal(integrationState(status, 'claude'), 'outdated');
	assert.equal(integrationState(status, 'codex'), 'not installed');
	assert.equal(integrationState(status, 'kimi'), undefined);

	const module = herdrModuleWith(() => status);
	const start = (harness: string) => ({ harness, cwd: '/', name: 'session.start' as const, source: 'startup' as const });
	const inside = { ...handlerContext(['herdr']), env: { HERDR_ENV: '1', PATH: fakeBinDir() } };
	assert.match((await module.handlers['session.start']!(start('claude'), inside))!.notice!, /integration is outdated.*herdr integration install claude/);
	assert.equal(await module.handlers['session.start']!(start('pi'), inside), undefined);
	assert.equal(await module.handlers['session.start']!(start('claude'), handlerContext(['herdr'])), undefined, 'outside Herdr it says nothing');
	const broken = herdrModuleWith(() => {
		throw Object.assign(new Error('x'), { stderr: 'no server' });
	});
	assert.match((await broken.handlers['session.start']!(start('claude'), inside))!.notice!, /integration status failed: no server/);
});
