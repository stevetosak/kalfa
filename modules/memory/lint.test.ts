import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type Layer, personalLayer, projectLayerOfKey } from '../../src/core/memory/home.ts';
import type { MemoryRecord, RecordStatus } from '../../src/core/memory/record.ts';
import { DEFAULT_MEMORY_BUDGETS } from '../../src/core/settings.ts';
import { lint, linkFindings } from './lint.ts';
import { memorySettings } from './settings.ts';

const personal = personalLayer('/home');
const project = projectLayerOfKey('/home', 'github.com/someone/project');

const rec = (id: string, body: string, status: RecordStatus = 'active'): MemoryRecord => ({
	id,
	header: { schema: 1, type: 'fact', status, summary: `${id} summary`, created: '2026-11-01', confirmed: '2026-11-01', ...(status === 'superseded' ? { 'superseded-by': 'git-habits' } : {}) },
	body,
});

const scans = (layers: [Layer, MemoryRecord[]][]) => layers.map(([layer, records]) => ({ layer, scan: { records, problems: [] } }));
const lines = (findings: ReturnType<typeof linkFindings>) => findings.map((f) => `${f.layer}/${f.id}: ${f.problem}`);

const personalRecords = [rec('git-habits', 'Stage by name: [[stage-by-name]], as [[personal:stage-by-name]] says.'), rec('stage-by-name', 'An example: `[[not-a-link]]`.')];

test('sound links give no finding: own layer, personal: from a project, and a link inside code', () => {
	const findings = linkFindings({
		scans: scans([
			[personal, personalRecords],
			[project, [rec('ci-secret', 'See [[deploy]] and [[personal:git-habits]].'), rec('deploy', '')]],
		]),
	});
	assert.deepEqual(findings, []);
});

test('a project record: a missing id, an id only the Personal layer has, an unknown prefix and a missing personal record', () => {
	const findings = linkFindings({
		scans: scans([
			[personal, personalRecords],
			[project, [rec('ci-secret', 'See [[nope]], [[git-habits]], [[work:deploy]] and [[personal:gone]].')]],
		]),
	});
	assert.deepEqual(lines(findings), [
		'github.com/someone/project/ci-secret: broken link [[nope]]: no record in this layer has that id. Correct the link with a supersede, or write the record it names',
		'github.com/someone/project/ci-secret: broken link [[git-habits]]: no record in this layer has that id, but the Personal layer has one: write [[personal:git-habits]]',
		"github.com/someone/project/ci-secret: broken link [[work:deploy]]: 'work' names no layer; only 'personal:' does",
		'github.com/someone/project/ci-secret: broken link [[personal:gone]]: no record in the Personal layer has that id. Correct the link with a supersede, or write the record it names',
	]);
});

test('a personal record that links into a project, by its id or with the project key, and one with a missing id', () => {
	const findings = linkFindings({
		scans: scans([
			[personal, [rec('vault-habits', 'Rotate per [[ci-secret]] and [[github.com/someone/project:deploy]]; see [[nope]].')]],
			[project, [rec('ci-secret', ''), rec('deploy', '')]],
		]),
	});
	assert.deepEqual(lines(findings), [
		"personal/vault-habits: link into a project [[ci-secret]] (a record of github.com/someone/project): a personal record links only to personal records. Link the other way: [[personal:vault-habits]] in the project's record",
		"personal/vault-habits: link into a project [[github.com/someone/project:deploy]]: a personal record links only to personal records. Link the other way: [[personal:vault-habits]] in the project's record",
		'personal/vault-habits: broken link [[nope]]: no record in this layer has that id. Correct the link with a supersede, or write the record it names',
	]);
});

test('a closed record still links and is checked; a superseded one is not', () => {
	const findings = linkFindings({
		scans: scans([[personal, [rec('git-habits', ''), rec('old', 'See [[nope]].', 'superseded'), rec('done', 'See [[nope]].', 'closed')]]]),
	});
	assert.deepEqual(
		findings.map((f) => f.id),
		['done'],
	);
});

test('the lint reports the link findings with the others', () => {
	const findings = lint({
		scans: scans([[personal, [rec('git-habits', 'See [[nope]].')]]]),
		budgets: DEFAULT_MEMORY_BUDGETS,
		ageLimits: memorySettings.parse({})['age-limits'],
		today: '2026-11-22',
	});
	assert.deepEqual(lines(findings), ['personal/git-habits: broken link [[nope]]: no record in this layer has that id. Correct the link with a supersede, or write the record it names']);
});
