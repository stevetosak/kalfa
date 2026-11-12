import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { NO_DECISIONS, sectionCommand, taskCommand } from '../src/cli/commands/task.ts';
import { main } from '../src/cli/main.ts';
import { writeCheckpoint } from '../src/core/checkpoint.ts';
import { ago, lastActivity, recapView } from '../src/core/recap.ts';
import { recordPath } from '../src/core/task-record.ts';
import { coreModule } from '../src/modules/core.ts';
import { fakeAdapter, registry } from './fakes.ts';
import { captureIo, gitRepo, tempDir } from './helpers.ts';

const modules = registry(coreModule);
const adapters = new Map([['fake', fakeAdapter]]);
const task = taskCommand(adapters, modules);
const section = sectionCommand(adapters, modules);

const PLAN = [
	'---',
	'title: Sessions',
	'type: plan',
	'status: active',
	'---',
	'',
	'## 1. Checkpoint',
	'',
	'**Done when:** it is kept.',
	'',
	'- [x] Keep it.',
	'',
	'## 2. Recap',
	'',
	'**Done when:** it is shown.',
	'',
	'- [x] Write the view.',
	'- [ ] Show it at session start.',
	'',
].join('\n');

const DAY = 24 * 60 * 60 * 1000;

function git(root: string, args: string[], date?: Date): void {
	const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
	if (date) Object.assign(env, { GIT_AUTHOR_DATE: date.toISOString(), GIT_COMMITTER_DATE: date.toISOString() });
	execFileSync('git', ['-C', root, ...args], { env, stdio: 'ignore' });
}

/** A repository on branch feat/recap whose first commit is `age` ms old. */
function repo(age = 0): string {
	const root = gitRepo({ 'kalfa.yaml': 'schema: 1\nplans: [docs/*.md]\n', '.gitignore': '.kalfa/\n', 'docs/plan.md': PLAN });
	git(root, ['checkout', '-q', '-b', 'feat/recap']);
	git(root, ['add', '.']);
	git(root, ['commit', '-q', '-m', 'first'], new Date(Date.now() - age));
	return root;
}

async function sectionOf(root: string, title: string, parts: string) {
	const io = captureIo(root, { HOME: tempDir() }, parts);
	assert.equal(await section.run(['close', title], io), 0);
	return io;
}

/** Sets the record's write time `age` ms back. */
function age(root: string, id: string, ms: number): void {
	const then = new Date(Date.now() - ms);
	utimesSync(recordPath(root, id), then, then);
}

test('the Recap: Plan parts, Task, recent Decisions, Next, Checkpoint, commits since, other Tasks', async () => {
	const root = repo(2 * 60 * 60 * 1000);
	await task.run(['start', '--plan', 'docs/plan.md', '--done-when', 'the Recap shows', 'Plan part 2: the recap'], captureIo(root));
	await sectionOf(root, 's1', '**Done:** a\n**Decisions:** first choice.\n');
	await sectionOf(root, 's2', '**Done:** b\n**Decisions:** keep the view plain.\n**Next:** show it at session start.\n');
	await task.run(['start', '--task', 'other', '--done-when', 'x', 'Other work'], captureIo(root));
	writeCheckpoint(root, { task: 'feat-recap', trigger: 'auto', at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(), summary: 'The summary.' });
	age(root, 'feat-recap', 60 * 60 * 1000);
	writeFileSync(join(root, 'a.txt'), 'a');
	git(root, ['add', 'a.txt']);
	git(root, ['commit', '-q', '-m', 'add the view']);

	const view = recapView(root, ['docs/*.md']);
	assert.match(view, /^Recap of \S+: last work/);
	assert.match(view, /Plan: Sessions \(active; docs\/plan\.md\)\n {2}1\. Checkpoint: done\n {2}2\. Recap: 1 of 2 steps done; next: Show it at session start\./);
	assert.match(view, /Task feat-recap \(open, started [\d-]+; .*feat-recap\.md\)\n {2}Goal: Plan part 2: the recap\n {2}Done when: the Recap shows\n {2}Sections: s1; s2/);
	assert.match(view, /Decisions \(the last Sections\):\n {4}s1:\n {6}first choice\.\n {4}s2:\n {6}keep the view plain\./);
	assert.match(view, /Next: show it at session start\./);
	assert.match(view, /Last Checkpoint: .* \(auto compaction, 2 hours ago\): .*checkpoints\/feat-recap\//);
	assert.match(view, /Commits since the record was last written \(.*\):\n {2}[0-9a-f]+ add the view\n/);
	assert.doesNotMatch(view, /first$/m);
	assert.match(view, /Other open Tasks:\n {2}- other: Other work/);
});

test('the Recap of a closed Task after the merge: the newest record, its close and no Checkpoint', async () => {
	const root = repo();
	await task.run(['start', '--done-when', 'done', 'Old work'], captureIo(root));
	await task.run(['start', '--task', 'newer', '--done-when', 'done', 'Newer work'], captureIo(root));
	await sectionOf(root, 's1', '**Done:** a\n**Decisions:** one.\n**Next:** close it.\n');
	await task.run(['close', '--task', 'newer'], captureIo(root, { HOME: tempDir() }, '**Done:** all.\n**Done when:** holds — seen.\n**Next:** Part 3.\n'));
	age(root, 'feat-recap', DAY);
	git(root, ['checkout', '-q', '-b', 'main']);

	const view = recapView(root, ['docs/*.md']);
	assert.match(view, /Task newer \(closed, started [\d-]+, closed [\d-]+;/);
	assert.match(view, /At close: holds — seen\./);
	assert.match(view, /Next: Part 3\./);
	assert.match(view, /Last Checkpoint: none/);
	assert.match(view, /Open Plans:\n- Sessions \(active, 2 of 3 steps done/, 'a Task without a Plan shows the open Plans');
	assert.match(view, /Other open Tasks:\n {2}- feat-recap: Old work/);
	assert.match(recapView(root, [], { task: 'feat/recap' }), /Task feat-recap \(open/, '--task picks a Task by id or branch');
});

test('the Recap shows the Decisions of the last three Sections only', async () => {
	const root = repo();
	await task.run(['start', '--done-when', 'x', 'goal'], captureIo(root));
	for (const n of [1, 2, 3, 4]) await sectionOf(root, `s${n}`, `**Done:** d\n**Decisions:** choice ${n}.\n`);
	const view = recapView(root, []);
	assert.doesNotMatch(view, /choice 1/);
	assert.match(view, /s2:\n {6}choice 2\.\n {4}s3:\n {6}choice 3\.\n {4}s4:\n {6}choice 4\./);
});

test('kalfa recap without Task Records says how to start one', async () => {
	const root = repo();
	const io = captureIo(root);
	assert.equal(await main(['recap'], io), 0);
	assert.match(io.stdout.join('\n'), /Open Plans:[\s\S]*No Task Records; start one with: kalfa task start/);
});

test('a Section without Decisions gets a warning; one with Decisions does not', async () => {
	const root = repo();
	await task.run(['start', '--done-when', 'x', 'goal'], captureIo(root));
	assert.deepEqual((await sectionOf(root, 'a', '**Done:** d\n')).stderr, [NO_DECISIONS]);
	assert.deepEqual((await sectionOf(root, 'b', '**Done:** d\n**Decisions:** c.\n')).stderr, []);
});

const settings = (afterDays?: number) => ({ schema: 1 as const, modules: [], ...(afterDays ? { recap: { 'after-days': afterDays } } : {}) });

/** A repository with an open Task and no activity for `days` days. */
async function idleRepo(days: number) {
	const root = repo(days * DAY);
	await task.run(['start', '--done-when', 'it shows', 'Plan part 2: the recap'], captureIo(root));
	await sectionOf(root, 'view', '**Done:** d\n**Decisions:** plain text.\n**Next:** the session start.\n');
	age(root, 'feat-recap', days * DAY);
	return root;
}

const start = (root: string, afterDays?: number, source: 'startup' | 'resume' = 'startup') =>
	coreModule.handlers['session.start']!(
		{ harness: 'fake', cwd: root, name: 'session.start', source },
		{ project: { root, file: { schema: 1, modules: [], plans: [], settings: {} } }, settings: settings(afterDays), env: { HOME: tempDir() }, capabilities: new Set() },
	);

test('a new session after 3 idle days starts with the Recap, once', async () => {
	const root = await idleRepo(3);
	const first = await start(root);
	assert.match(first!.context!, /^The Operator comes back to this repository after 3 days without activity\. Before other work, tell the Operator .* The Recap \(kalfa recap\):\n\nRecap of/);
	assert.match(first!.context!, /Decisions \(the last Sections\):\n {4}view:\n {6}plain text\./);
	assert.match(first!.notice!, /Recap after 3 days away/);
	assert.match(first!.notice!, /kalfa: 3 days since the last activity here\.\nTask feat-recap: Plan part 2: the recap\n[\s\S]*Next: the session start\.\n\/where-was-i/);
	assert.ok(existsSync(join(root, '.kalfa', 'last-session')));

	const second = await start(root);
	assert.doesNotMatch(second!.context!, /The Recap/);
	assert.match(second!.context!, /Open Tasks in this repository/);
});

test('no Recap before the idle days, on a resume, or under a longer after-days setting', async () => {
	assert.doesNotMatch((await start(await idleRepo(1)))!.context!, /The Recap/);
	assert.doesNotMatch((await start(await idleRepo(3), undefined, 'resume'))!.context ?? '', /The Recap/);
	assert.doesNotMatch((await start(await idleRepo(3), 5))!.context!, /The Recap/);
	assert.match((await start(await idleRepo(3), 1))!.context!, /The Recap/);
});

test('activity is the newest of the HEAD commit, the records and the session stamp', async () => {
	const root = await idleRepo(4);
	const since = lastActivity(root)!;
	assert.ok(Date.now() - since.getTime() >= 4 * DAY - 1000);
	writeFileSync(join(root, '.kalfa', 'last-session'), 'now\n');
	assert.ok(Date.now() - lastActivity(root)!.getTime() < 60_000);
	const now = new Date();
	assert.equal(ago(new Date(now.getTime() - 3 * DAY), now), '3 days ago');
	assert.equal(ago(new Date(now.getTime() - 5 * 60_000), now), '5 minutes ago');
});

test('a commit in the same second as the record write, but before it, is not "since"', async () => {
	const commit = new Date(Math.floor((Date.now() - DAY) / 1000) * 1000);
	const root = gitRepo({ 'kalfa.yaml': 'schema: 1\n', '.gitignore': '.kalfa/\n' });
	git(root, ['checkout', '-q', '-b', 'feat/recap']);
	git(root, ['add', '.']);
	git(root, ['commit', '-q', '-m', 'same second'], commit);
	await task.run(['start', '--done-when', 'x', 'goal'], captureIo(root));
	const write = new Date(commit.getTime() + 500);
	utimesSync(recordPath(root, 'feat-recap'), write, write);
	assert.match(recapView(root, []), /Commits since the record was last written \(.*\):\n {2}none/);
});
