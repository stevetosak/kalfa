import assert from 'node:assert/strict';
import { test } from 'node:test';
import { personalLayer, projectLayerOfKey } from '../../src/core/memory/home.ts';
import type { MemoryRecord, RecordStatus, RecordType } from '../../src/core/memory/record.ts';
import { cutText, rootHubFindings, rootHubText } from './root-hubs.ts';

const personal = personalLayer('/home');
const project = projectLayerOfKey('/home', 'github.com/someone/project');

const rec = (id: string, type: RecordType, body = '', status: RecordStatus = 'active', next?: string): MemoryRecord => ({
	id,
	header: { schema: 1, type, status, summary: `${id} summary`, created: '2026-11-01', confirmed: '2026-11-01', ...(next ? { 'superseded-by': next } : {}) },
	body,
});

const scan = (records: MemoryRecord[]) => ({ records, problems: [] });
const links = (n: number) => Array.from({ length: n }, (_, i) => `- Subject ${i}: [[subject-hub-${i}]]`).join('\n');

test('cutText cuts at a line end; at a word end when the line end keeps less than half; else at the limit', () => {
	assert.equal(cutText('short', 10), 'short');
	assert.equal(cutText('line one\nline two\nline three', 20), 'line one\nline two');
	assert.equal(cutText('a\nlong words without a line end here', 18), 'a\nlong words', 'the limit falls inside a word');
	assert.equal(cutText('abcdefghijklmnopqrstuvwxyz', 10), 'abcdefghij');
});

test('a Root Hub under its limit loads whole, with a heading that names the layer and the id to show', () => {
	const hub = rootHubText(project, [rec('root', 'hub', links(2)), rec('a-fact', 'fact')], 1500)!;
	assert.equal(hub.cut, false);
	assert.equal(
		hub.text,
		[
			'Root Hub of the Project layer (github.com/someone/project); read a linked record with kalfa memory show <id> (kalfa memory show root for this one):',
			'root summary',
			'',
			links(2),
		].join('\n'),
	);
	assert.equal(hub.chars, hub.text.length);
	assert.match(rootHubText(personal, [rec('root', 'hub')], 1500)!.text, /^Root Hub of the Personal layer; [^\n]*\nroot summary$/);
	assert.equal(rootHubText(project, [rec('a-fact', 'fact')], 1500), undefined, 'a layer without a Root Hub');
});

test('a superseded Root Hub loads its successor, by the successor id', () => {
	const hub = rootHubText(project, [rec('root', 'hub', '', 'superseded', 'kalfa-map'), rec('kalfa-map', 'hub', links(1))], 1500)!;
	assert.equal(hub.record.id, 'kalfa-map');
	assert.match(hub.text, /kalfa memory show kalfa-map for this one/);
});

test('a Root Hub over its limit loads cut at a line end, with a pointer, in at most the limit', () => {
	const hub = rootHubText(project, [rec('root', 'hub', links(80))], 1500)!;
	assert.equal(hub.cut, true);
	assert.ok(hub.text.length <= 1500, `${hub.text.length} characters`);
	assert.ok(hub.chars > 1500);
	assert.match(hub.text, /\n- Subject \d+: \[\[subject-hub-\d+\]\]\n… cut at 1500 characters: kalfa memory show root has the rest$/, 'no link is split');
});

test('the lint names a root record that is not a hub and a Root Hub over its limit; a sound one gives nothing', () => {
	assert.deepEqual(rootHubFindings(project, scan([rec('root', 'hub', links(2))]), 1500), []);
	assert.deepEqual(rootHubFindings(project, scan([rec('a-fact', 'fact')]), 1500), []);
	assert.deepEqual(rootHubFindings(project, scan([rec('root', 'hub', '', 'closed')]), 1500), [], 'a closed Root Hub is a choice, not a fault');
	assert.deepEqual(rootHubFindings(project, scan([rec('root', 'fact')]), 1500), [
		{
			layer: 'github.com/someone/project',
			id: 'root',
			problem: "the layer's root record is a fact, not a hub: it does not load as the Root Hub, and the layer loads its index lines. The id 'root' is kept for the Root Hub",
		},
	]);
	const [over] = rootHubFindings(personal, scan([rec('root', 'hub', '', 'superseded', 'map'), rec('map', 'hub', links(80))]), 1500);
	assert.equal(over?.id, 'map');
	assert.match(over?.problem ?? '', /^the Root Hub is \d+ characters, over its limit of 1500 \(memory\.root-hub-chars\): the session start loads it cut\./);
});
