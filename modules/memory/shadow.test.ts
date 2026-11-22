import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { tempDir } from '../../test/helpers.ts';
import { memoryModule, promptWords } from './handlers.ts';
import type { Hit } from './search.ts';
import { SHADOW_HITS, shadowEntry, shadowLogPath } from './shadow.ts';

/** Prompts and whether `promptWords` gives them words to search with. */
const PROMPTS: [string, boolean][] = [
	['how do we rotate the database password', true],
	['ye', false],
	['start it', false],
	['continue', false],
	['/kalfa-status', false],
	['/meter 200k now please', false],
	['  /code-review high this branch', false],
	['\n/clear the old thing', false],
	['line one\nline two', true],
	['a\nb', false],
	['a\tb\tc', true],
	['a\r\nb\r\nc', true],
	['say "hi" to them', true],
	['"quoted" start here', true],
	['C:\\new path x', true],
	['C:\\new', false],
	['x\\ty z', false],
	['über straße café', true],
	['emoji 🎉 party', true],
	['a b   ', false],
	['  leading a b', true],
	['a  b', false],
	['\u00a0a b c', true],
	['a\u2003b c', false],
];

/** Whether bash, as the shim does, matches `filter` against each payload. */
function bashMatches(filter: string, payloads: string[], locale: string): boolean[] {
	const script = 'while IFS= read -r -d "" p; do if [[ $p =~ $FILTER ]]; then echo 1; else echo 0; fi; done';
	const out = execFileSync('bash', ['-c', script], { input: payloads.map((p) => `${p}\0`).join(''), env: { ...process.env, FILTER: filter, LC_ALL: locale } });
	return out.toString().trim().split('\n').map((line) => line === '1');
}

test("the shim's prompt filter starts Node exactly for the prompts promptWords keeps, in any locale and payload layout", () => {
	for (const [prompt, searchable] of PROMPTS) assert.equal(promptWords(prompt) !== '', searchable, JSON.stringify(prompt));
	const filter = memoryModule.filters['prompt.submit'];
	const compact = PROMPTS.map(([prompt]) => JSON.stringify({ session_id: 's', transcript_path: '/t.jsonl', cwd: '/r', hook_event_name: 'UserPromptSubmit', prompt }));
	const pretty = PROMPTS.map(([prompt]) => JSON.stringify({ prompt, session_id: 's' }, null, 2));
	for (const locale of ['C', 'C.UTF-8'])
		for (const payloads of [compact, pretty]) {
			const matched = bashMatches(filter, payloads, locale);
			PROMPTS.forEach(([prompt, searchable], i) => assert.equal(matched[i], searchable, `${locale}: ${payloads[i]}`));
		}
});

const hit = (score: number, extra: Partial<Hit> = {}): Hit => ({ kind: 'doc', title: `t${score}`, ref: `docs/a.md:${score}`, snippet: '', score, ...extra });

test('a shadow line holds the hits with their share of the best score, the band, what the session holds and what recall injected, and no prompt text', () => {
	const own = hit(9, { kind: 'task', task: 'feat-x', ref: '.kalfa/tasks/feat-x.md:3' });
	const record = hit(4, { kind: 'memory', record: { id: 'the-fact', layer: 'personal' }, ref: 'kalfa memory show the-fact (personal)' });
	const weak = hit(2);
	const many = Array.from({ length: SHADOW_HITS }, (_, i) => hit(1 - i / 100));
	const prompt = 'where is the secret zebra answer';
	const entry = shadowEntry({
		at: new Date('2026-11-22T10:00:00Z'),
		session: 's1',
		project: 'github.com/a/b',
		task: 'feat-x',
		first: true,
		prompt,
		words: 6,
		hits: [record, own, weak, ...many],
		held: (h) => h.task === 'feat-x',
		injected: [record],
	});
	assert.deepEqual(entry.hits.slice(0, 3), [
		{ kind: 'memory', tier: 'long-term', ref: 'kalfa memory show the-fact (personal)', record: 'personal/the-fact', score: 4, share: 0.444, band: true, held: false },
		{ kind: 'task', tier: 'short-term', ref: '.kalfa/tasks/feat-x.md:3', score: 9, share: 1, band: true, held: true },
		{ kind: 'doc', tier: 'long-term', ref: 'docs/a.md:2', score: 2, share: 0.222, band: false, held: false },
	]);
	assert.equal(entry.hits.length, SHADOW_HITS, 'cut at the limit');
	assert.equal(entry.matches, 3 + SHADOW_HITS, 'the count before the cut');
	assert.deepEqual(entry.injected, ['personal/the-fact']);
	assert.deepEqual({ ...entry, hits: [], injected: [] }, {
		at: '2026-11-22T10:00:00.000Z',
		session: 's1',
		project: 'github.com/a/b',
		task: 'feat-x',
		first: true,
		// printf '%s' "$prompt" | sha256sum
		prompt: { sha256: 'bfedd9502eefc305', words: 6 },
		matches: 13,
		hits: [],
		injected: [],
	});
	assert.doesNotMatch(JSON.stringify(entry), /zebra/, 'the text stays in the transcript');
	const none = shadowEntry({ at: new Date(), first: false, prompt: 'x y z', words: 3, hits: [], held: () => false, injected: [] });
	assert.deepEqual([none.hits, none.matches, 'session' in none, 'project' in none, 'task' in none], [[], 0, false, false, false]);
});

test('parallel sessions append to one day file without losing or mixing a line', async () => {
	const cache = tempDir();
	const at = new Date();
	const writers = 6;
	const lines = 60;
	const shadow = resolve('modules/memory/shadow.ts');
	// Each line is several kilobytes, more than one pipe buffer, so a torn write would show.
	const code = `
		import { appendShadow } from ${JSON.stringify(shadow)};
		const at = new Date(${at.getTime()});
		const ref = 'docs/long.md:'.padEnd(400, 'x');
		for (let i = 0; i < ${lines}; i++) {
			const hits = Array.from({ length: 10 }, () => ({ kind: 'doc', tier: 'long-term', ref, score: 1, share: 1, band: true, held: false }));
			appendShadow({ XDG_CACHE_HOME: process.env.XDG_CACHE_HOME }, at, { at: at.toISOString(), session: process.argv[1], first: false, prompt: { sha256: 'x', words: 3 }, matches: 10, hits, injected: [] });
		}`;
	const run = (session: string) =>
		new Promise<void>((done, fail) => {
			const child = spawn(process.execPath, ['--input-type=module', '-e', code, session], { env: { ...process.env, XDG_CACHE_HOME: cache }, stdio: 'inherit' });
			child.on('exit', (status) => (status === 0 ? done() : fail(new Error(`writer exited ${status}`))));
		});
	await Promise.all(Array.from({ length: writers }, (_, i) => run(`s${i}`)));
	const text = readFileSync(shadowLogPath({ XDG_CACHE_HOME: cache }, at), 'utf8');
	assert.ok(text.length > writers * lines * 4096, `${text.length} bytes`);
	const entries = text.trimEnd().split('\n').map((line) => JSON.parse(line) as { session: string });
	assert.equal(entries.length, writers * lines);
	for (let i = 0; i < writers; i++) assert.equal(entries.filter((e) => e.session === `s${i}`).length, lines);
	assert.equal(shadowLogPath({ XDG_CACHE_HOME: cache }, at), join(cache, 'kalfa', 'memory-shadow', `${at.toLocaleDateString('sv-SE')}.jsonl`));
});
