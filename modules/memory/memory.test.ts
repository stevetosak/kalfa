import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { memoryCommand } from '../../src/cli/commands/memory.ts';
import { sectionCommand, taskCommand } from '../../src/cli/commands/task.ts';
import { dispatch } from '../../src/core/dispatcher.ts';
import { KalfaError } from '../../src/core/errors.ts';
import { handledEvents } from '../../src/core/fast-path.ts';
import { memoryHome, personalLayer, scanLayer } from '../../src/core/memory/home.ts';
import { renderMemoryRecord } from '../../src/core/memory/record.ts';
import type { HandlerContext } from '../../src/core/modules.ts';
import { loadProject } from '../../src/core/project.ts';
import { DEFAULT_MEMORY_BUDGETS, loadSettings } from '../../src/core/settings.ts';
import { coreModule } from '../../src/modules/core.ts';
import { memoryExtensions } from '../../src/modules/index.ts';
import { fakeAdapter, registry } from '../../test/fakes.ts';
import { captureIo, gitRepo, tempRepo } from '../../test/helpers.ts';
import { candidateFiles, readInbox, splitCandidates } from './inbox.ts';
import { lint } from './lint.ts';
import { memoryModule } from './handlers.ts';
import { openIndex } from './search.ts';
import { memorySettings } from './settings.ts';
import { markdownPieces } from './sources.ts';

const KEY = 'github.com/someone/project';
const adapters = new Map([[fakeAdapter.name, fakeAdapter]]);
const modules = registry(coreModule, memoryModule);

/** A machine with the memory Module on, and a repository with an origin, tracked docs and a feature branch. */
function machine(settings = '') {
	const home = tempRepo({ '.config/kalfa/config.yaml': `schema: 1\nmodules: [memory]\n${settings}` });
	const repo = gitRepo({
		'kalfa.yaml': 'schema: 1\nmodules: []\n',
		'.gitignore': '.kalfa/\n',
		'docs/runbook.md': '# Runbook\n\n## Rotate the database password\n\nThe password lives in the Secret Catalog. Rotate it with kluster.\n',
		'docs/other.md': '## Gateway\n\nEnvoy serves every route.\n',
		'.claude/decisions-history.md': '# History\n\nThe zebra decision was archived here.\n',
	});
	const git = (...args: string[]) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args]);
	git('remote', 'add', 'origin', 'git@github.com:Someone/Project.git');
	git('add', 'kalfa.yaml', '.gitignore', 'docs');
	git('commit', '-q', '-m', 'init');
	git('checkout', '-q', '-b', 'feat/rotation');
	return { home, repo, env: { HOME: home } as NodeJS.ProcessEnv };
}

function contextOf(repo: string, env: NodeJS.ProcessEnv): HandlerContext {
	return { project: loadProject(repo), settings: loadSettings(env), env, capabilities: fakeAdapter.capabilities };
}

async function run(command: { run(args: string[], io: ReturnType<typeof captureIo>): Promise<number> }, cwd: string, env: NodeJS.ProcessEnv, args: string[], stdin = '') {
	const io = captureIo(cwd, env, stdin);
	try {
		const code = await command.run(args, io);
		return { code, out: io.stdout.join('\n'), err: io.stderr.join('\n'), error: undefined as string | undefined };
	} catch (error) {
		if (error instanceof KalfaError) return { code: 1, out: io.stdout.join('\n'), err: io.stderr.join('\n'), error: error.message };
		throw error;
	}
}

const memory = (cwd: string, env: NodeJS.ProcessEnv, args: string[], stdin = '') => run(memoryCommand(memoryExtensions), cwd, env, args, stdin);
const homeLog = (env: NodeJS.ProcessEnv) => execFileSync('git', ['-C', memoryHome(env), 'log', '--format=%s'], { encoding: 'utf8' }).trim().split('\n');

async function startTask(repo: string, env: NodeJS.ProcessEnv, candidates: string) {
	await run(taskCommand(adapters, modules), repo, env, ['start', '--done-when', 'it works', 'Rotate the database password']);
	const parts = `**Done:** Wrote the rotation.\n\n**Memory candidates:** ${candidates}\n\n**Next:** Rotate the database password with kluster.`;
	const section = await run(sectionCommand(adapters, modules), repo, env, ['close', 'Rotation'], parts);
	assert.equal(section.code, 0, section.error ?? section.err);
}

test('markdownPieces nests headings by level, ignores headings in code fences and splits long sections', () => {
	const pieces = markdownPieces('intro\n## A\ntext a\n```\n# not a heading\n```\n### B\ntext b\n## C\ntext c\n');
	assert.deepEqual(
		pieces.map((p) => [p.headings.join(' › '), p.line]),
		[
			['', 1],
			['A', 2],
			['A › B', 7],
			['C', 9],
		],
	);
	const long = markdownPieces(`## Long\n${'word '.repeat(50)}\n\n${'more '.repeat(50)}\n`, 300);
	assert.equal(long.length, 2);
	assert.ok(long.every((p) => p.text.length <= 300 && p.headings[0] === 'Long'));
});

test('splitCandidates takes one candidate per top-level bullet, and none for "none"', () => {
	assert.deepEqual(splitCandidates('- first\n  more of first\n- second'), ['first\n  more of first', 'second']);
	assert.deepEqual(splitCandidates('One plain candidate.'), ['One plain candidate.']);
	assert.deepEqual(splitCandidates('none'), []);
	assert.deepEqual(splitCandidates('- None.\n- real'), ['real']);
});

test('candidateFiles does not write a candidate twice for the same Task', () => {
	const home = tempRepo();
	const files = candidateFiles(home, { project: KEY, task: 'feat-x', created: '2026-10-31' }, ['a', 'b']);
	assert.deepEqual(
		files.map((f) => f.id),
		['project-feat-x-1', 'project-feat-x-2'],
	);
	mkdirSync(join(home, 'inbox'));
	writeFileSync(files[0]!.path, files[0]!.text);
	assert.deepEqual(
		candidateFiles(home, { project: KEY, task: 'feat-x', created: '2026-10-31' }, ['a', 'c']).map((f) => [f.id, f.candidate]),
		[['project-feat-x-2', 'c']],
	);
});

test('the lint reports stale records, broken links, duplicates and unreadable files, and gives no age limit to a decision', () => {
	const home = tempRepo();
	const layer = personalLayer(home);
	mkdirSync(layer.dir, { recursive: true });
	const put = (id: string, header: Record<string, unknown>) =>
		writeFileSync(join(layer.dir, `${id}.md`), renderMemoryRecord({ header: { schema: 1, status: 'active', created: '2026-01-01', confirmed: '2026-01-01', ...header } as never, body: '' }));
	put('old-fact', { type: 'fact', summary: 'The laptop has hybrid graphics' });
	put('old-decision', { type: 'decision', summary: 'Kalfa ships one bundle' });
	put('gone', { type: 'fact', status: 'superseded', 'superseded-by': 'missing', summary: 'Old thing', confirmed: '2026-10-30' });
	put('stage-a', { type: 'rule', summary: 'Stage files by name never by folder', confirmed: '2026-10-30' });
	put('stage-b', { type: 'rule', summary: 'Stage files by name, never a whole folder', confirmed: '2026-10-30' });
	writeFileSync(join(layer.dir, 'broken.md'), 'no header');
	const settings = memorySettings.parse({});
	const findings = lint({ scans: [{ layer, scan: scanLayer(layer) }], budgets: DEFAULT_MEMORY_BUDGETS, ageLimits: settings['age-limits'], today: '2026-10-31' });
	const text = findings.map((f) => `${f.id ?? ''}: ${f.problem}`).join('\n');
	assert.match(text, /old-fact: stale: last confirmed 2026-01-01 \(303 days; a fact is checked every 90\)/);
	assert.doesNotMatch(text, /old-decision/);
	assert.match(text, /gone: superseded-by 'missing' names no record/);
	assert.match(text, /stage-b: likely a duplicate of personal\/stage-a/);
	assert.match(text, /left out of every session: .*broken\.md/);
	assert.equal(findings.length, 4);
});

test('search finds docs, archives, records and Task Records, and reads the cache until a source changes', async () => {
	const { repo, env } = machine();
	assert.equal((await memory(repo, env, ['add', '--type', 'fact', '--layer', 'project', '--summary', 'The Secret Catalog lists every database secret.'])).code, 0);
	const scope = { project: loadProject(repo), env, archives: memorySettings.parse({}).archives };
	const first = openIndex(scope);
	assert.equal(first.cached, false);
	const refs = first.search('database password secret', 10).map((h) => `${h.kind} ${h.ref}`);
	assert.ok(refs.includes('doc docs/runbook.md:3'), refs.join('\n'));
	assert.ok(refs.some((r) => r.startsWith('memory kalfa memory show the-secret-catalog')), refs.join('\n'));
	assert.deepEqual(
		first.search('zebra', 5).map((h) => `${h.kind} ${h.ref}`),
		['archive .claude/decisions-history.md:1'],
	);
	assert.equal(openIndex(scope).cached, true);
	writeFileSync(join(repo, 'docs/other.md'), '## Gateway\n\nEnvoy serves every route, also the zebra one.\n');
	const changed = openIndex(scope);
	assert.equal(changed.cached, false);
	assert.equal(changed.search('zebra', 5).length, 2);
	const out = await memory(repo, env, ['search', 'Envoy']);
	assert.match(out.out, /\[doc\] docs\/other\.md › Gateway\n {4}docs\/other\.md:1/);
});

test('search keeps a closed record and marks it', async () => {
	const { repo, env } = machine();
	await memory(repo, env, ['add', '--type', 'open', '--layer', 'project', '--summary', 'Wire the zeppelin gateway.']);
	assert.equal((await memory(repo, env, ['close', 'wire-the-zeppelin-gateway', 'wired'])).code, 0);
	const scope = { project: loadProject(repo), env, archives: memorySettings.parse({}).archives };
	const titles = openIndex(scope).search('zeppelin', 5).map((h) => h.title);
	assert.deepEqual(titles, ['open (closed): Wire the zeppelin gateway.']);
});

test('task close copies the record into the Memory home and puts the candidates into the inbox in one commit', async () => {
	const { repo, env } = machine();
	await startTask(repo, env, '- The rotation needs kluster.\n- Envoy times out at 15 s.');
	const close = await run(taskCommand(adapters, modules), repo, env, ['close'], '**Done when:** holds — the test ran.\n');
	assert.equal(close.code, 0, close.error ?? close.err);
	const home = memoryHome(env);
	assert.ok(existsSync(join(home, 'projects', ...KEY.split('/'), 'tasks', 'feat-rotation.md')));
	const inbox = readInbox(home).candidates;
	assert.deepEqual(
		inbox.map((c) => [c.id, c.project, c.task, c.text]),
		[
			['project-feat-rotation-1', KEY, 'feat-rotation', 'The rotation needs kluster.'],
			['project-feat-rotation-2', KEY, 'feat-rotation', 'Envoy times out at 15 s.'],
		],
	);
	assert.deepEqual(homeLog(env), [`close task feat-rotation (${KEY}): copy the record, 2 candidates to the inbox`]);
	assert.match(close.out, /Ask the Operator ONE question[\s\S]*- project-feat-rotation-1: The rotation needs kluster\./);
});

test('session start recalls for the open Task without its own record, and counts the inbox', async () => {
	const { repo, env } = machine();
	await startTask(repo, env, 'none');
	mkdirSync(join(memoryHome(env), 'inbox'), { recursive: true });
	writeFileSync(join(memoryHome(env), 'inbox', 'x-1.md'), `---\nschema: 1\nproject: ${KEY}\ntask: other\ncreated: 2026-10-31\n---\n\nA candidate.\n`);
	const result = await dispatch({ name: 'session.start', harness: 'fake', cwd: repo, source: 'startup' }, modules, contextOf(repo, env));
	const context = result.context.join('\n');
	assert.match(context, /Recall for Task feat-rotation[\s\S]*\[doc\] docs\/runbook\.md › Runbook › Rotate the database password — docs\/runbook\.md:3/);
	assert.doesNotMatch(context, /\[task\] Task feat-rotation/);
	assert.match(context, /1 Memory candidate waits in the inbox/);
	assert.ok(result.notice.includes('kalfa: memory: recall 1 hit · 1 in the inbox'), result.notice.join('\n'));
});

test('recall on each prompt is off by default: the shim does not run for it, and the Dispatcher skips it', async () => {
	const off = machine();
	const offContext = contextOf(off.repo, off.env);
	assert.ok(!handledEvents([memoryModule], offContext).includes('prompt.submit'));
	assert.ok(handledEvents([memoryModule]).includes('prompt.submit'), 'without a context every handler counts');
	const prompt = { name: 'prompt.submit', harness: 'fake', cwd: off.repo, prompt: 'how do we rotate the database password' } as const;
	assert.deepEqual((await dispatch(prompt, modules, offContext)).context, []);

	const on = machine('settings:\n  memory:\n    recall-on-prompt: true\n');
	const onContext = contextOf(on.repo, on.env);
	assert.ok(handledEvents([memoryModule], onContext).includes('prompt.submit'));
	assert.match((await dispatch({ ...prompt, cwd: on.repo }, modules, onContext)).context.join('\n'), /Recall for this prompt[\s\S]*docs\/runbook\.md:3/);
	assert.deepEqual((await dispatch({ ...prompt, cwd: on.repo, prompt: '/meter 200k' }, modules, onContext)).context, []);
});

test('inbox accept writes the record into the layer of the candidate project and removes the candidate in one commit', async () => {
	const { repo, env } = machine();
	await startTask(repo, env, '- The rotation needs kluster.\n- A wrong idea.');
	await run(taskCommand(adapters, modules), repo, env, ['close'], '**Done when:** holds — the test ran.\n');
	// Run from outside the repository: the project layer still is the candidate's.
	const elsewhere = gitRepo();
	const accept = await memory(elsewhere, env, ['inbox', 'accept', 'project-feat-rotation-1', '--type', 'fact', '--layer', 'project', '--summary', 'Rotating a password needs kluster.']);
	assert.equal(accept.code, 0, accept.error);
	const record = join(memoryHome(env), 'projects', ...KEY.split('/'), 'rotating-a-password-needs-kluster.md');
	assert.match(readFileSync(record, 'utf8'), /source: Task feat-rotation \(github\.com\/someone\/project\)/);
	const reject = await memory(repo, env, ['inbox', 'reject', 'project-feat-rotation-2', 'not true']);
	assert.equal(reject.code, 0, reject.error);
	assert.equal(readInbox(memoryHome(env)).candidates.length, 0);
	assert.deepEqual(homeLog(env).slice(0, 2), ['reject candidate project-feat-rotation-2: not true', `add fact rotating-a-password-needs-kluster (${KEY})`]);
	assert.match((await memory(repo, env, ['inbox'])).out, /the inbox is empty/);
});

test('the Module subcommands are refused where the memory Module is off', async () => {
	const repo = gitRepo({ 'kalfa.yaml': 'schema: 1\nmodules: []\n' });
	const env = { HOME: tempRepo({ '.config/kalfa/config.yaml': 'schema: 1\nmodules: []\n' }) };
	assert.match((await memory(repo, env, ['search', 'x'])).error ?? '', /the memory Module is not on here/);
	assert.match((await memory(repo, env, ['inbox'])).error ?? '', /the memory Module is not on here/);
	assert.equal((await memory(repo, env, ['list'])).code, 0, 'the Core subcommands still work');
});
