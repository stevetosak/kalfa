import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { taskCommand } from '../src/cli/commands/task.ts';
import { writeCheckpoint } from '../src/core/checkpoint.ts';
import { mainCheckout } from '../src/core/private-dir.ts';
import { lastActivity, markSession } from '../src/core/recap.ts';
import { listRecords, readRecord } from '../src/core/task-record.ts';
import { setWake, wakePath } from '../src/core/wake.ts';
import { coreModule } from '../src/modules/core.ts';
import { fakeAdapter, registry } from './fakes.ts';
import { captureIo, gitRepo, tempDir } from './helpers.ts';

/** A repository with one commit and a worktree on `feat/side` next to it. */
function repoWithWorktree() {
	const main = realpathSync(gitRepo({ 'kalfa.yaml': 'schema: 1\n', '.gitignore': '.kalfa/\n' }));
	const git = (...args: string[]) => execFileSync('git', ['-C', main, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { stdio: 'ignore' });
	git('add', 'kalfa.yaml', '.gitignore');
	git('commit', '-q', '-m', 'init');
	const worktree = join(realpathSync(tempDir()), 'side');
	git('worktree', 'add', '-q', '-b', 'feat/side', worktree);
	return { main, worktree };
}

test('a worktree keeps its Task Records, Checkpoints and session stamp in the main checkout', async () => {
	const { main, worktree } = repoWithWorktree();
	assert.equal(mainCheckout(worktree), main);
	assert.equal(mainCheckout(main), main);

	const task = taskCommand(new Map([['fake', fakeAdapter]]), registry(coreModule));
	await task.run(['start', '--done-when', 'it works', 'Side work'], captureIo(worktree, { HOME: tempDir() }));
	assert.equal(readRecord(main, 'feat-side')?.path, join(main, '.kalfa/tasks/feat-side.md'));
	assert.deepEqual(listRecords(worktree).map((r) => r.id), ['feat-side'], 'the worktree reads the same records');
	assert.ok(!existsSync(join(worktree, '.kalfa/tasks')));

	const checkpoint = writeCheckpoint(worktree, { task: 'feat-side', trigger: 'manual', at: '2026-11-13T10:00:00.000Z', summary: 'Where it stood.' });
	assert.ok(checkpoint.startsWith(join(main, '.kalfa/checkpoints/feat-side/')), checkpoint);

	markSession(worktree);
	assert.ok(existsSync(join(main, '.kalfa/last-session')));
	assert.ok(lastActivity(main), 'the main checkout sees the worktree session');
});

test('the wake markers stay in each checkout, where the hook shim looks', () => {
	const { main, worktree } = repoWithWorktree();
	setWake(worktree, 'session.start', { data: {} });
	assert.equal(wakePath(worktree, 'session.start'), join(worktree, '.kalfa/wake/session.start'));
	assert.ok(existsSync(wakePath(worktree, 'session.start')));
	assert.ok(!existsSync(join(main, '.kalfa/wake')));
});
