import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RELEVANT_SHARE, rankHits, tierOf } from './ranking.ts';
import type { SourceKind } from './sources.ts';

interface Fake {
	name: string;
	kind: SourceKind;
	score: number;
	closed?: boolean;
	day?: string;
}

const order = (hits: Fake[]) => rankHits(hits, (hit) => hit.day).map((hit) => hit.name);

test('in the relevant band Long-term comes before Short-term, and Short-term before the archive, whatever the score', () => {
	assert.deepEqual(
		order([
			{ name: 'archive', kind: 'archive', score: 100 },
			{ name: 'task', kind: 'task', score: 90 },
			{ name: 'record', kind: 'memory', score: 40 },
			{ name: 'doc', kind: 'doc', score: 30 },
			{ name: 'deferred', kind: 'deferred', score: 26 },
		]),
		['record', 'doc', 'deferred', 'task', 'archive'],
	);
});

test('a hit under the band comes after every hit in it, and the weak hits keep the tier order', () => {
	const floor = RELEVANT_SHARE * 100;
	assert.deepEqual(
		order([
			{ name: 'strong task', kind: 'task', score: 100 },
			{ name: 'weak archive', kind: 'archive', score: floor - 1 },
			{ name: 'weak record', kind: 'memory', score: floor - 2 },
			{ name: 'edge archive', kind: 'archive', score: floor },
		]),
		['strong task', 'edge archive', 'weak record', 'weak archive'],
	);
});

test('a closed record and a closed deferred item rank with the archive, after the Task Records', () => {
	assert.equal(tierOf({ kind: 'memory', closed: true }), 'archive');
	assert.equal(tierOf({ kind: 'deferred', closed: true }), 'archive');
	assert.deepEqual(
		order([
			{ name: 'closed record', kind: 'memory', closed: true, score: 100 },
			{ name: 'task', kind: 'task', score: 50 },
			{ name: 'record', kind: 'memory', score: 40 },
		]),
		['record', 'task', 'closed record'],
	);
});

test('in a tier the latest use day comes first, a hit without one after them, and the score breaks a tie', () => {
	assert.deepEqual(
		order([
			{ name: 'no day', kind: 'doc', score: 100 },
			{ name: 'old', kind: 'memory', score: 90, day: '2026-10-01' },
			{ name: 'new, lower', kind: 'memory', score: 40, day: '2026-11-20' },
			{ name: 'new, higher', kind: 'memory', score: 60, day: '2026-11-20' },
		]),
		['new, higher', 'new, lower', 'old', 'no day'],
	);
});

test('no hits rank to no hits, and hits with a score of 0 keep the tier order', () => {
	assert.deepEqual(order([]), []);
	assert.deepEqual(
		order([
			{ name: 'task', kind: 'task', score: 0 },
			{ name: 'record', kind: 'memory', score: 0 },
		]),
		['record', 'task'],
	);
});
