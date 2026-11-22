import assert from 'node:assert/strict';
import { test } from 'node:test';
import { personalLayer, projectLayerOfKey } from '../../src/core/memory/home.ts';
import { LinkGraph, type LinkNode, linkText, neighbourLines, parseLinks } from './links.ts';
import type { MemoryRecord, RecordStatus, RecordType } from '../../src/core/memory/record.ts';

const personal = personalLayer('/home');
const project = projectLayerOfKey('/home', 'github.com/someone/project');

const rec = (id: string, body: string, type: RecordType = 'fact', status: RecordStatus = 'active', supersededBy?: string): MemoryRecord => ({
	id,
	header: { schema: 1, type, status, summary: `${id} summary`, created: '2026-11-01', confirmed: '2026-11-01', ...(supersededBy ? { 'superseded-by': supersededBy } : {}) },
	body,
});

test('parseLinks reads [[id]] and [[prefix:id]] once each, in order, and not inside code', () => {
	const body = [
		'Stage by name ([[stage-by-name]]), as [[personal:git-habits]] says; again [[stage-by-name]].',
		'An unknown layer: [[work:x]]. Not ids: [[Bad Id]], [[]].',
		'In code: `[[inline-example]]` and',
		'```',
		'[[fenced-example]]',
		'```',
	].join('\n');
	assert.deepEqual(parseLinks(body), [{ id: 'stage-by-name' }, { prefix: 'personal', id: 'git-habits' }, { prefix: 'work', id: 'x' }]);
});

test('a link resolves in its own layer, or in the Personal layer with the prefix; back-links come from every layer', () => {
	const graph = new LinkGraph([
		{ layer: personal, records: [rec('git-habits', 'Stage by name: [[stage-by-name]].', 'hub'), rec('stage-by-name', '')] },
		{ layer: project, records: [rec('ci-secret', 'See [[personal:git-habits]], [[deploy]], [[work:x]] and [[stage-by-name]].'), rec('deploy', '')] },
	]);
	const node = (layer: typeof personal, id: string) => graph.find(layer, id)!;
	const targets = graph.links(node(project, 'ci-secret')).map((t) => ('node' in t ? `${t.node.layer.label}/${t.node.record.id}` : linkText(t.missing)));
	assert.deepEqual(targets, ['personal/git-habits', 'github.com/someone/project/deploy', '[[work:x]]', '[[stage-by-name]]'], 'a plain id never leaves its layer');
	assert.deepEqual(
		graph.backLinks(node(personal, 'git-habits')).map((n) => n.record.id),
		['ci-secret'],
	);
	assert.deepEqual(
		graph.backLinks(node(personal, 'stage-by-name')).map((n) => n.record.id),
		['git-habits'],
	);
});

test('a superseded record links to nothing, but a link to it names its successor', () => {
	const graph = new LinkGraph([
		{ layer: personal, records: [rec('old', 'Was about [[topic]].', 'fact', 'superseded', 'new'), rec('new', 'About [[topic]] and [[old]].'), rec('topic', '', 'hub')] },
	]);
	const topic = graph.find(personal, 'topic')!;
	assert.deepEqual(
		graph.backLinks(topic).map((n) => n.record.id),
		['new'],
	);
	const fromNew = graph.find(personal, 'new')!;
	assert.deepEqual(neighbourLines(fromNew, graph.neighbourhood(fromNew, 1)), ['- → [hub] topic summary (topic)', '- → [fact, superseded by new] old summary (old)']);
});

test('the neighbourhood goes breadth first to its depth, and each record appears once', () => {
	// hub → a, hub → b, a → c, c → d; b → a (already reached at level 1).
	const graph = new LinkGraph([
		{
			layer: personal,
			records: [rec('hub', '[[a]] [[b]]', 'hub'), rec('a', '[[c]]'), rec('b', '[[a]] [[gone]]', 'open', 'closed'), rec('c', '[[d]]', 'decision'), rec('d', '')],
		},
	]);
	const hub: LinkNode = graph.find(personal, 'hub')!;
	assert.deepEqual(graph.neighbourhood(hub, 0), []);
	assert.deepEqual(neighbourLines(hub, graph.neighbourhood(hub, 1)), ['- → [fact] a summary (a)', '- → [open, closed] b summary (b)']);
	assert.deepEqual(neighbourLines(hub, graph.neighbourhood(hub, 2)), [
		'- → [fact] a summary (a)',
		'  - → [decision] c summary (c)',
		'- → [open, closed] b summary (b)',
		'  - → [[gone]]: no such record',
	]);
	const c = graph.find(personal, 'c')!;
	assert.deepEqual(neighbourLines(c, graph.neighbourhood(c, 1)), ['- → [fact] d summary (d)', '- ← [fact] a summary (a)']);
});

test('a neighbour in another layer than the record shown names its layer', () => {
	const graph = new LinkGraph([
		{ layer: personal, records: [rec('git-habits', '', 'hub')] },
		{ layer: project, records: [rec('ci-secret', '[[personal:git-habits]]')] },
	]);
	const habits = graph.find(personal, 'git-habits')!;
	assert.deepEqual(neighbourLines(habits, graph.neighbourhood(habits, 1)), ['- ← [fact] ci-secret summary (ci-secret, github.com/someone/project)']);
});
