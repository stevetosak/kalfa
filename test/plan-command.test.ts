import assert from 'node:assert/strict';
import { test } from 'node:test';
import { main } from '../src/cli/main.ts';
import { captureIo, tempRepo } from './helpers.ts';

const plan = (title: string, status: string, body: string) => `---\ntitle: ${title}\ntype: plan\nstatus: ${status}\n---\n${body}`;

function repo(globs = "['docs/**/*.md']") {
	return tempRepo({
		'kalfa.yaml': `schema: 1\nplans: ${globs}\n`,
		'docs/rebuild.md': plan('Rebuild', 'active', '- [x] **Rotate** keys.\n  - [ ] check the old key is gone\n- [ ] **Monitoring**\n'),
		'docs/old.md': plan('Old', 'done', '- [x] all\n'),
	});
}

async function run(root: string, ...argv: string[]) {
	const io = captureIo(root);
	const code = await main(['plan', ...argv], io);
	return { code, stdout: io.stdout.join('\n'), stderr: io.stderr.join('\n') };
}

test('plan list shows the open Plans, --all every Plan', async () => {
	const root = repo();
	assert.deepEqual(await run(root, 'list'), { code: 0, stdout: '- Rebuild (active, 1 of 2 steps done; docs/rebuild.md)\n  Next: check the old key is gone', stderr: '' });
	assert.match((await run(root, 'list', '--all')).stdout, /^- Old \(done, 1 of 1 steps done; docs\/old\.md\)\n- Rebuild/);
});

test('plan show lists the open steps with their lines, under a done parent too', async () => {
	const { code, stdout } = await run(repo(), 'show', 'docs/rebuild.md');
	assert.equal(code, 0);
	assert.match(stdout, /Open steps:\n- line 6 \(done\): Rotate\n {2}- line 7: check the old key is gone\n- line 8: Monitoring$/);
	assert.equal((await run(repo(), 'show', 'docs/nope.md')).code, 1);
});

test('plan check passes a clean repository and fails on a broken Plan', async () => {
	assert.deepEqual(await run(repo(), 'check'), { code: 0, stdout: '2 Plan(s), 2 open step(s): no problems', stderr: '' });
	const root = tempRepo({ 'kalfa.yaml': "schema: 1\nplans: ['*.md']\n", 'p.md': plan('P', 'done', '- [ ] left\n') });
	const out = await run(root, 'check');
	assert.equal(out.code, 1);
	assert.match(out.stderr, /^p\.md: a done Plan has 1 open step\(s\), first at line 6/);
});

test('without plans: globs the command says where to list them', async () => {
	const out = await run(tempRepo({ 'kalfa.yaml': 'schema: 1\n' }), 'list');
	assert.equal(out.code, 1);
	assert.match(out.stderr, /list their globs under 'plans:' in kalfa\.yaml/);
	assert.equal((await run(repo(), 'nope')).code, 2);
});
