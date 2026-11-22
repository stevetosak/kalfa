import assert from 'node:assert/strict';
import { test } from 'node:test';
import { captureIo, gitRepo, tempDir } from '../../test/helpers.ts';
import { guardrailsCommand } from './command.ts';
import { protectedRefs } from './pre-push.ts';

const ZERO = '0'.repeat(40);
const ref = (local: string, remote: string, object = 'a'.repeat(40)) => `${local} ${object} ${remote} ${'b'.repeat(40)}`;

test('the refs git hands the hook: a push to or a delete of a protected branch is refused, other refs pass', () => {
	const branches = ['main', 'master'];
	assert.deepEqual(protectedRefs(ref('refs/heads/feat/x', 'refs/heads/main'), branches), ["a push to the protected branch 'main'"]);
	assert.deepEqual(protectedRefs(`${ref('(delete)', 'refs/heads/master', ZERO)}\n`, branches), ["a delete of the protected branch 'master'"]);
	const many = [ref('refs/heads/a', 'refs/heads/feat/a'), ref('refs/heads/main', 'refs/heads/main'), ref('refs/heads/main', 'refs/heads/main')].join('\n');
	assert.deepEqual(protectedRefs(many, branches), ["a push to the protected branch 'main'"], 'one reason per branch');
	for (const input of ['', '\n', ref('refs/heads/main', 'refs/heads/main-old'), ref('refs/tags/main', 'refs/tags/main'), ref('refs/heads/x', 'refs/heads/feat/main')]) {
		assert.deepEqual(protectedRefs(input, branches), [], input);
	}
});

test('kalfa guardrails pre-push reads the protected branches from kalfa.yaml, else main and master', async () => {
	const env = { HOME: tempDir() };
	const plain = gitRepo();
	const run = async (cwd: string, stdin: string, args = ['pre-push', 'origin', 'git@x:y.git']) => {
		const io = captureIo(cwd, env, stdin);
		return { status: await guardrailsCommand().run(args, io), err: io.stderr.join('') };
	};

	const main = await run(plain, ref('refs/heads/main', 'refs/heads/main'));
	assert.equal(main.status, 1);
	assert.match(main.err, /^kalfa guardrails refused a push to the protected branch 'main' \(remote origin\)/);
	assert.equal((await run(plain, ref('refs/heads/trunk', 'refs/heads/trunk'))).status, 0);

	const trunk = gitRepo({ 'kalfa.yaml': 'schema: 1\nmodules: []\nsettings:\n  guardrails:\n    protected-branches: [trunk]\n' });
	assert.equal((await run(trunk, ref('refs/heads/trunk', 'refs/heads/trunk'))).status, 1);
	assert.equal((await run(trunk, ref('refs/heads/main', 'refs/heads/main'))).status, 0);

	await assert.rejects(run(plain, '', ['pre-push']), /kalfa guardrails pre-push <remote>/);
	const broken = gitRepo({ 'kalfa.yaml': 'schema: 1\nmodules: []\nsettings:\n  guardrails:\n    protected-branches: trunk\n' });
	await assert.rejects(run(broken, ref('refs/heads/x', 'refs/heads/x')), /settings\.guardrails/, 'a broken setting stops the check, so the hook refuses');
});
