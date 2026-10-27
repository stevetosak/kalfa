import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { test } from 'node:test';
import { claudeAdapter } from '../../src/adapters/claude/adapter.ts';
import { dispatch } from '../../src/core/dispatcher.ts';
import { DEFAULT_SETTINGS } from '../../src/core/settings.ts';
import { gitRepo } from '../../test/helpers.ts';
import { guardrailsModule } from './handlers.ts';
import { type GitRead, protectedPushes, simpleCommands } from './push-rule.ts';

const PROTECTED = ['main', 'master'];

/** A repository whose checked-out branch is `branch`, tracking `upstream`. */
const onBranch = (branch: string | undefined, upstream?: string): GitRead => (_dir, args) => (args[0] === 'symbolic-ref' ? branch : upstream);

const refused = (line: string, git: GitRead = onBranch('feat/x')) => protectedPushes(line, '/repo', PROTECTED, git);

test('a command line splits into simple commands, quotes kept and variables as written', () => {
	assert.deepEqual(simpleCommands('cd x && git push -f origin "HEAD:main"; echo $(git push) | cat'), [
		['cd', 'x'],
		['git', 'push', '-f', 'origin', 'HEAD:main'],
		['echo', '$'],
		['git', 'push'],
		['cat'],
	]);
});

test('every form of a push to a protected branch is refused', () => {
	for (const line of [
		'git push origin main',
		'git push origin feat/x:main',
		'git push -f origin +HEAD:refs/heads/master',
		'git push --force-with-lease=main:abc origin main',
		'cd sub && GIT_TRACE=1 git -C .. push -u origin main',
		'git push --delete origin main',
		'git push --all origin',
		'git push -o ci.skip origin main',
	]) {
		assert.notDeepEqual(refused(line), [], line);
	}
	assert.match(refused('git push origin HEAD', onBranch('main'))[0]!, /protected branch 'main' \(git push origin HEAD\)/);
	assert.notDeepEqual(refused('git push', onBranch('master')), []);
	assert.notDeepEqual(refused('git push', onBranch('feat/x', 'origin/main')), [], 'a branch that tracks main');
	assert.match(refused('git push origin "$BRANCH"')[0]!, /is a variable/);
});

test('other pushes and other commands pass', () => {
	for (const line of ['git push origin feat/x', 'git push', 'git push origin HEAD', 'git push --dry-run origin main', 'git log main', 'echo git push origin main', 'gh pr merge 1']) {
		assert.deepEqual(refused(line, onBranch('feat/x', 'origin/feat/x')), [], line);
	}
});

test('the bare push is judged on the branch checked out in the folder git runs in', () => {
	const root = gitRepo();
	execFileSync('git', ['-C', root, 'switch', '-q', '-c', 'main']);
	assert.notDeepEqual(protectedPushes(`cd ${root} && git push`, '/', PROTECTED), []);
	execFileSync('git', ['-C', root, 'switch', '-q', '-c', 'feat/y']);
	assert.deepEqual(protectedPushes(`git -C ${root} push`, '/', PROTECTED), []);
});

test('the Module blocks through the Dispatcher, reads its protected branches from kalfa.yaml, and fails closed', async () => {
	const registry = new Map([['guardrails', guardrailsModule]]);
	const context = (settings: Record<string, unknown>) => ({
		project: { root: '/repo', file: { schema: 1 as const, modules: ['guardrails'], plans: [], settings } },
		settings: DEFAULT_SETTINGS,
		env: {},
		capabilities: claudeAdapter.capabilities,
	});
	const event = (command: string) => ({ harness: 'claude', cwd: join('/', 'repo'), name: 'command.before' as const, command });

	const blocked = await dispatch(event('git push origin main'), registry, context({}));
	assert.match(blocked.block[0]!, /^kalfa guardrails refused a push to the protected branch 'main'/);
	assert.deepEqual((await dispatch(event('git push origin trunk'), registry, context({}))).block, []);
	assert.equal((await dispatch(event('git push origin trunk'), registry, context({ guardrails: { 'protected-branches': ['trunk'] } }))).block.length, 1);

	const broken = await dispatch(event('git push origin x'), registry, context({ guardrails: { 'protected-branches': 'trunk' } }));
	assert.match(broken.block[0]!, /Module guardrails failed on command\.before: kalfa\.yaml settings\.guardrails[\s\S]*could not run/);
});
