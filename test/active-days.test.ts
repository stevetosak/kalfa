import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { activeDays, localDay, markActiveDay } from '../src/core/active-days.ts';
import type { SessionStartSource } from '../src/core/events.ts';
import { coreModule } from '../src/modules/core.ts';
import { gitRepo, tempDir } from './helpers.ts';

// A zone east of UTC, so that near midnight the local day and the UTC day differ (CI runs in UTC).
process.env.TZ = 'Europe/Skopje';

function git(root: string, args: string[], committed?: string, authored = committed): void {
	const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
	if (committed) Object.assign(env, { GIT_COMMITTER_DATE: committed, GIT_AUTHOR_DATE: authored });
	execFileSync('git', ['-C', root, ...args], { env, stdio: 'ignore' });
}

/** A repository with a first commit at `committed`; it ignores `.kalfa/` unless told not to. */
function repo(committed: string, ignoresKalfa = true): string {
	const root = realpathSync(gitRepo({ 'kalfa.yaml': 'schema: 1\n', ...(ignoresKalfa && { '.gitignore': '.kalfa/\n' }) }));
	git(root, ['add', '.']);
	git(root, ['commit', '-q', '-m', 'first'], committed);
	return root;
}

const commit = (root: string, committed: string, authored = committed) => git(root, ['commit', '-q', '--allow-empty', '-m', committed], committed, authored);
const recorded = (root: string) => readFileSync(join(root, '.kalfa/active-days'), 'utf8');

const start = (root: string, source: SessionStartSource) =>
	coreModule.handlers['session.start']!(
		{ harness: 'fake', cwd: root, name: 'session.start', source },
		{ project: { root, file: { schema: 1, modules: [], plans: [], settings: {} } }, settings: { schema: 1, modules: [] }, env: { HOME: tempDir() }, capabilities: new Set() },
	);

test('a day is the local date, not the UTC one', () => {
	assert.equal(localDay(new Date('2026-11-21T23:30:00Z')), '2026-11-22');
});

test('a session start records its local day once', () => {
	const root = repo('2026-11-01T10:00:00Z');
	markActiveDay(root, new Date('2026-11-21T23:30:00Z'));
	markActiveDay(root, new Date('2026-11-22T10:00:00Z'));
	markActiveDay(root, new Date('2026-11-23T10:00:00Z'));
	assert.equal(recorded(root), '2026-11-22\n2026-11-23\n');
});

test('every session start records the day, whatever started it', async () => {
	for (const source of ['startup', 'clear', 'resume', 'compact', 'fork'] as const) {
		const root = repo('2026-11-01T10:00:00Z');
		await start(root, source);
		assert.equal(recorded(root), `${localDay(new Date())}\n`, source);
	}
});

test('nothing is written where git does not ignore .kalfa/, and the session start goes on', async () => {
	const root = repo('2026-11-01T10:00:00Z', false);
	assert.doesNotThrow(() => markActiveDay(root));
	await assert.doesNotReject(async () => start(root, 'startup'));
	assert.ok(!existsSync(join(root, '.kalfa')));
	assert.deepEqual(activeDays(root), ['2026-11-01'], 'the commit days still count');
});

/**
 * Commits on 11-02 (two), on 11-04, on 11-05 on a branch that is not checked
 * out, and on 11-07 local time (23:30 UTC on 11-06), authored on 10-01;
 * sessions on 11-03 and 11-04.
 */
function busyRepo(): string {
	const root = repo('2026-11-02T09:00:00Z');
	commit(root, '2026-11-02T15:00:00Z');
	git(root, ['checkout', '-q', '-b', 'side']);
	commit(root, '2026-11-05T09:00:00Z');
	git(root, ['checkout', '-q', '-']);
	commit(root, '2026-11-04T09:00:00Z');
	commit(root, '2026-11-06T23:30:00Z', '2026-10-01T09:00:00Z');
	markActiveDay(root, new Date('2026-11-03T10:00:00Z'));
	markActiveDay(root, new Date('2026-11-04T10:00:00Z'));
	return root;
}

test('the Active days join the session days and the commit days of every branch, sorted, each once', () => {
	assert.deepEqual(activeDays(busyRepo()), ['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-07']);
});

test('since keeps that local day and the later ones', () => {
	const root = busyRepo();
	assert.deepEqual(activeDays(root, '2026-11-04'), ['2026-11-04', '2026-11-05', '2026-11-07']);
	assert.deepEqual(activeDays(root, '2026-11-07'), ['2026-11-07'], 'a commit at 00:30 local time is on its local day');
	assert.deepEqual(activeDays(root, '2026-11-08'), []);
});
