import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { claudeAdapter } from '../../src/adapters/claude/adapter.ts';
import { sectionCommand, taskCommand } from '../../src/cli/commands/task.ts';
import { coreModule } from '../../src/modules/core.ts';
import { fakeAdapter, handlerContext, registry } from '../../test/fakes.ts';
import { captureIo, gitRepo, tempDir } from '../../test/helpers.ts';
import { cleanWorkspaces, diskLookups, duration, finishedWorkspaces, type HerdrAgent, type Lookups, refreshLabels, renderBoard, type Snapshot } from './board.ts';
import { boardCommand } from './command.ts';
import { herdrModuleWith } from './handlers.ts';
import type { HerdrExec } from './launcher.ts';

const answer = (result: unknown) => JSON.stringify({ id: 'cli', result });

/** A herdr that answers `list` from the snapshot and records every call. */
function fakeHerdr(snapshot: Snapshot) {
	const calls: string[][] = [];
	const exec: HerdrExec = (args) => {
		calls.push(args);
		const lists: Record<string, unknown> = {
			'workspace list': { workspaces: snapshot.workspaces },
			'tab list': { tabs: snapshot.tabs },
			'pane list': { panes: snapshot.panes },
			'agent list': { agents: snapshot.agents },
		};
		return answer(lists[args.slice(0, 2).join(' ')] ?? {});
	};
	return { exec, calls };
}

/** A repository on branch `feat/<name>` with that branch's Task, and optionally a closed Task. */
async function repoWithTask(name: string, { close = false, next }: { close?: boolean; next?: string } = {}) {
	const root = gitRepo({ 'kalfa.yaml': 'schema: 1\n', '.gitignore': '.kalfa/\n' });
	execFileSync('git', ['-C', root, 'checkout', '-q', '-b', `feat/${name}`]);
	const env = { HOME: tempDir() };
	await taskCommand(new Map([['fake', fakeAdapter]]), registry(coreModule)).run(['start', '--done-when', 'it works', `Work on ${name}`], captureIo(root, env));
	if (next) await sectionCommand(new Map([['fake', fakeAdapter]]), registry(coreModule)).run(['close', 'First'], captureIo(root, env, `**Done:** a\n**Decisions:** b\n**Next:** ${next}\n`));
	if (close) await taskCommand(new Map([['fake', fakeAdapter]]), registry(coreModule)).run(['close'], captureIo(root, env, '**Done when:** holds — the test says so\n'));
	return root;
}

const agent = (pane: string, cwd: string, extra: Partial<HerdrAgent> = {}): HerdrAgent => ({
	pane_id: pane,
	tab_id: pane.replace(':p', ':t'),
	workspace_id: pane.split(':')[0]!,
	cwd,
	agent: 'claude',
	agent_status: 'idle',
	...extra,
});

const snapshotOf = (agents: HerdrAgent[], extraPanes: Snapshot['panes'] = []): Snapshot => ({
	workspaces: [...new Set([...agents, ...extraPanes].map((a) => a.workspace_id))].map((id) => ({ workspace_id: id, label: `space-${id}` })),
	tabs: agents.map((a) => ({ tab_id: a.tab_id, label: `tab-${a.tab_id}` })),
	panes: [...agents.map(({ pane_id, tab_id, workspace_id, cwd }) => ({ pane_id, tab_id, workspace_id, cwd })), ...extraPanes],
	agents,
});

test('the board shows each session with its Task, state, context, last request, cache and Next, by workspace', async () => {
	const open = await repoWithTask('open', { next: 'Write the tests.' });
	const closed = await repoWithTask('closed', { close: true });
	const plain = tempDir();
	const snapshot = snapshotOf([
		agent('w1:p1', open, { agent_status: 'working', terminal_title_stripped: 'Board work' }),
		agent('w1:p2', plain, { agent: 'pi', name: 'helper' }),
		agent('w2:p1', closed, { agent_status: 'done', name: 'old' }),
	]);
	const real = diskLookups(new Map(), {}, 0);
	const lookups: Lookups = {
		...real,
		use: (a) => (a.pane_id === 'w1:p1' ? { context: 152_400, idleMs: 120_000, warm: true } : a.pane_id === 'w2:p1' ? { context: 66_000, idleMs: 3 * 3_600_000, warm: false } : undefined),
	};
	const board = renderBoard(snapshot, lookups, finishedWorkspaces(snapshot, lookups));
	assert.equal(
		board,
		[
			'3 agent sessions in 2 workspaces; 1 finished (kalfa board --clean).',
			'',
			'space-w1 (w1)',
			'  claude "Board work" · working · Task feat-open · 152k tokens · last request 2m ago · cache warm',
			'    Next: Write the tests.',
			'  pi helper "tab-w1:t2" · idle · no Task · context —',
			'',
			'space-w2 (w2) — finished: no open Task',
			'  claude old "tab-w2:t1" · done · Task feat-closed (closed) · 66k tokens · last request 3h ago · cache cold',
		].join('\n'),
	);
	assert.deepEqual([duration(59_000), duration(47 * 3_600_000), duration(50 * 3_600_000)], ['0m', '47h', '2d']);
});

test('a workspace is finished only when its repositories have Task Records and none is open', async () => {
	const closed = await repoWithTask('closed', { close: true });
	const open = await repoWithTask('open');
	const untracked = gitRepo();
	const outside = tempDir();
	const lookups = diskLookups(new Map(), {}, 0);
	const pane = (id: string, cwd: string) => ({ pane_id: id, tab_id: id.replace(':p', ':t'), workspace_id: id.split(':')[0]!, cwd });
	const snapshot = snapshotOf([], [pane('w1:p1', closed), pane('w1:p2', untracked), pane('w1:p3', outside), pane('w2:p1', closed), pane('w2:p2', open), pane('w3:p1', untracked), pane('w4:p1', outside)]);
	assert.deepEqual([...finishedWorkspaces(snapshot, lookups)], ['w1'], 'a repository without records or a folder outside one does not hold a workspace open');
});

test('clean lists the finished workspaces; with yes it closes them, but keeps one where an agent works or waits', () => {
	const snapshot = snapshotOf([agent('w1:p1', '/a'), agent('w2:p1', '/b', { agent_status: 'working' }), agent('w3:p1', '/c')]);
	const finished = new Set(['w1', 'w2']);
	const listed = fakeHerdr(snapshot);
	const list = cleanWorkspaces(listed.exec, snapshot, finished, false);
	assert.deepEqual(list.slice(0, 2), ['- space-w1 (w1; claude idle)', '- space-w2 (w2; claude working)']);
	assert.match(list.at(-1)!, /After the Operator's yes: kalfa board --clean --yes/);
	assert.equal(listed.calls.length, 0, 'listing closes nothing');

	const closing = fakeHerdr(snapshot);
	assert.deepEqual(cleanWorkspaces(closing.exec, snapshot, finished, true), ['- space-w1 (w1; claude idle): closed', '- space-w2 (w2; claude working): kept, an agent works or waits there']);
	assert.deepEqual(closing.calls, [['workspace', 'close', 'w1']]);
	assert.match(cleanWorkspaces(closing.exec, snapshot, new Set(), true)[0]!, /No finished workspace/);
});

test('labels: the repository\'s agent panes get the task and next tokens, its workspaces the finished token', async () => {
	const open = await repoWithTask('label', { next: `Do ${'x'.repeat(100)}` });
	const other = gitRepo();
	const snapshot = snapshotOf([agent('w1:p1', open), agent('w1:p2', other), agent('w2:p1', open)]);
	const { exec, calls } = fakeHerdr(snapshot);
	assert.deepEqual(refreshLabels(exec, open, diskLookups(new Map(), {}, 0)), []);
	const reports = calls.filter((c) => c[1] === 'report-metadata');
	assert.deepEqual(reports.map((c) => c.slice(0, 3)), [['pane', 'report-metadata', 'w1:p1'], ['pane', 'report-metadata', 'w2:p1'], ['workspace', 'report-metadata', 'w1'], ['workspace', 'report-metadata', 'w2']]);
	const pane = reports[0]!;
	assert.deepEqual(pane.slice(3, 7), ['--source', 'kalfa', '--token', 'task=feat-label']);
	assert.equal(pane[8]!.length, 'next='.length + 80, 'a token value is clipped to Herdr\'s 80 characters');
	assert.match(pane[8]!, /^next=Do x+…$/);
	assert.deepEqual(reports[2]!.slice(5), ['--clear-token', 'finished']);

	const closed = await repoWithTask('done', { close: true });
	const after = fakeHerdr(snapshotOf([agent('w1:p1', closed)]));
	assert.deepEqual(refreshLabels(after.exec, closed, diskLookups(new Map(), {}, 0)), ['space-w1']);
	const [paneReport, spaceReport] = after.calls.filter((c) => c[1] === 'report-metadata');
	assert.deepEqual(paneReport!.slice(5), ['--token', 'task=feat-done (closed)', '--clear-token', 'next']);
	assert.deepEqual(spaceReport!.slice(5), ['--token', 'finished=finished']);
});

test('the session use comes from the transcript: context, time since the last request, and the cache against its TTL', () => {
	const projects = tempDir();
	mkdirSync(join(projects, '-home-op-kalfa'));
	const at = Date.parse('2026-11-12T10:00:00Z');
	const line = JSON.stringify({ type: 'assistant', requestId: 'r1', timestamp: new Date(at).toISOString(), message: { model: 'claude-opus-5-5', usage: { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 99_990, cache_creation_input_tokens: 0, cache_creation: { ephemeral_1h_input_tokens: 0 } } } });
	writeFileSync(join(projects, '-home-op-kalfa', 'abc.jsonl'), `${line}\n`);
	const env = { CLAUDE_PROJECTS_DIR: projects };
	const session = agent('w1:p1', '/x', { agent_session: { kind: 'id', value: 'abc' } });
	const adapters = new Map([['claude', claudeAdapter]]);
	assert.deepEqual(diskLookups(adapters, env, at + 30 * 60_000).use(session), { context: 100_000, idleMs: 30 * 60_000, warm: true });
	assert.equal(diskLookups(adapters, env, at + 61 * 60_000).use(session)!.warm, false);
	assert.equal(diskLookups(adapters, env, at).use({ ...session, agent_session: { kind: 'id', value: 'missing' } }), undefined);
	assert.equal(diskLookups(adapters, env, at).use({ ...session, agent: 'pi' }), undefined, 'no Adapter, no usage');
});

/** A folder with an executable `herdr`, for the PATH check of inHerdr. */
function herdrOnPath(): string {
	const dir = tempDir();
	writeFileSync(join(dir, 'herdr'), '#!/bin/sh\nexit 0\n');
	chmodSync(join(dir, 'herdr'), 0o755);
	return dir;
}

test('Task close inside Herdr labels the panes and names a finished workspace; outside Herdr nothing runs', async () => {
	const closed = await repoWithTask('end', { close: true });
	const { exec, calls } = fakeHerdr(snapshotOf([agent('w1:p1', closed)]));
	const module = herdrModuleWith(exec);
	const context = { ...handlerContext(['herdr'], closed), env: { HOME: tempDir(), HERDR_ENV: '1', PATH: herdrOnPath() } };
	const result = await module.handlers['task.close']!({ name: 'task.close', task: 'feat-end', record: '' } as never, context);
	assert.match(result!.notice!, /workspace space-w1 has no open Task left.*kalfa board --clean.*only after their yes/);
	assert.ok(calls.some((c) => c[0] === 'workspace' && c[1] === 'report-metadata'));

	const section = await module.handlers['section.close']!({ name: 'section.close', task: 'feat-end', record: '' } as never, context);
	assert.equal(section, undefined, 'only Task close names the finished workspace');

	const outside = fakeHerdr(snapshotOf([agent('w1:p1', closed)]));
	assert.equal(await herdrModuleWith(outside.exec).handlers['task.close']!({ name: 'task.close' } as never, handlerContext(['herdr'], closed)), undefined);
	assert.equal(outside.calls.length, 0);
});

test('kalfa board: --yes needs --clean; a herdr failure is an error that names it', async () => {
	const failing = boardCommand(new Map(), { exec: () => { throw Object.assign(new Error('exit 1'), { stderr: 'no server' }); } });
	await assert.rejects(failing.run(['--yes'], captureIo(tempDir())), /--yes goes with --clean/);
	await assert.rejects(failing.run([], captureIo(tempDir())), /reads its sessions from Herdr, and herdr failed: no server/);
	const { exec } = fakeHerdr(snapshotOf([]));
	const io = captureIo(tempDir());
	assert.equal(await boardCommand(new Map(), { exec }).run([], io), 0);
	assert.equal(io.stdout.join('\n'), '0 agent sessions in 0 workspaces.');
});
