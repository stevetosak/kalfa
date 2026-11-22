import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { claudeAdapter } from '../../src/adapters/claude/adapter.ts';
import { dispatch } from '../../src/core/dispatcher.ts';
import { DEFAULT_SETTINGS } from '../../src/core/settings.ts';
import { guardrailsModule } from './handlers.ts';
import { hookSkips, simpleCommands } from './shell-rule.ts';

test('a command line splits into simple commands; a quoted text is one word, and each line starts with no quote open', () => {
	assert.deepEqual(simpleCommands(`cd x && git push -f origin "HEAD:main"; echo $(git push) | cat`), [
		['cd', 'x'],
		['git', 'push', '-f', 'origin', 'HEAD:main'],
		['echo', '$'],
		['git', 'push'],
		['cat'],
	]);
	assert.deepEqual(simpleCommands(`git commit -m "a \\"b\\" c" ''`), [['git', 'commit', '-m', 'a "b" c', '']]);
	assert.deepEqual(simpleCommands("cat <<EOF\ndon't\nEOF\ngit push `id`"), [['cat', '<<EOF'], ['dont'], ['EOF'], ['git', 'push'], ['id']]);
});

const SKIPS = [
	'git push --no-verify origin feat/x',
	'git push origin feat/x --no-verify',
	'cd sub && git -C .. push "--no-verify"',
	'git -c core.hooksPath=/dev/null push origin main',
	'git -c "core.hookspath=/var/empty" push',
	'git --config-env=core.hooksPath=DIR push',
	'git --config-env core.HooksPath=DIR push',
	'GIT_CONFIG_COUNT=0 git push origin main',
	'export GIT_CONFIG_VALUE_0=/var/empty; git push',
	"env GIT_CONFIG_PARAMETERS=\"'core.hooksPath'='/x'\" git push",
	'unset GIT_CONFIG_COUNT && git push',
	'export -n GIT_CONFIG_KEY_0',
	'env -u GIT_CONFIG_COUNT git push',
	'env -uGIT_CONFIG_COUNT git push',
	'env --unset=GIT_CONFIG_COUNT git push',
	'env -i PATH=/usr/bin git push origin main',
	'/usr/bin/env --ignore-environment git push',
	'env -C sub -iv git push',
	'env - git push',
	'echo $(git push --no-verify)',
];

test('every command that makes the agent\'s git skip its hooks is refused, and the Module filter lets each through', () => {
	const filter = new RegExp(guardrailsModule.filters['command.before']);
	for (const line of SKIPS) {
		assert.notDeepEqual(hookSkips(line), [], line);
		assert.match(line, filter, `the shim filter misses: ${line}`);
	}
	assert.match(hookSkips('git push --no-verify origin x')[0]!, /^--no-verify on a push skips the push check \(git push --no-verify origin x\)$/);
	assert.match(hookSkips('GIT_CONFIG_COUNT=0 git push')[0]!, /\(GIT_CONFIG_COUNT=0\)/);
});

test('pushes, reads and texts that only name the words pass, the old false refusals among them', () => {
	for (const line of [
		'git push origin main',
		'git push --force-with-lease origin feat/x',
		'git commit --no-verify -m x && git push',
		"git commit -m 'refuse a push --no-verify'",
		'git config core.hooksPath .githooks',
		'git config --type=path core.hooksPath',
		'git -C repo config --get core.hooksPath',
		'printenv GIT_CONFIG_COUNT GIT_CONFIG_VALUE_0',
		'echo "$GIT_CONFIG_VALUE_0"',
		'env | grep GIT_CONFIG_',
		'GIT_CONFIG_GLOBAL=/dev/null git push origin feat/x',
		'env -i HOME=/var/empty PATH=/usr/bin node dist/kalfa.mjs doctor',
		'env GIT_SSH_COMMAND="ssh -i ~/.ssh/k" git push origin feat/x',
		"python3 - <<'PY'\ns = f'${JSON.stringify(value)} push'\nPY",
		"cat > f.ts <<'EOF'\nconst a = `${x.y} git push`;\nEOF",
	]) {
		assert.deepEqual(hookSkips(line), [], line);
	}
});

test('the Module blocks through the Dispatcher and names the way out', async () => {
	const registry = new Map([['guardrails', guardrailsModule]]);
	const context = {
		project: { root: '/repo', file: { schema: 1 as const, modules: ['guardrails'], plans: [], settings: {} } },
		settings: DEFAULT_SETTINGS,
		env: {},
		capabilities: claudeAdapter.capabilities,
	};
	const event = (command: string) => ({ harness: 'claude', cwd: join('/', 'repo'), name: 'command.before' as const, command });

	const blocked = await dispatch(event('git push --no-verify origin feat/x'), registry, context);
	assert.match(blocked.block[0]!, /^kalfa guardrails refused: --no-verify on a push skips the push check/);
	assert.match(blocked.block[0]!, /in a file \(Write tool\)/);
	assert.deepEqual((await dispatch(event('git push origin main'), registry, context)).block, [], 'the pre-push hook judges the push');
});
