import assert from 'node:assert/strict';
import { test } from 'node:test';
import { filterChoices } from './prompter.ts';

test('a search keeps the choices that hold every typed word, in their order', () => {
	const choices = [
		{ value: 1, name: 'shop', description: '~/code/active/shop' },
		{ value: 2, name: 'web-net', description: '~/code/active/web-net' },
		{ value: 3, name: 'docs' },
	];
	assert.deepEqual(filterChoices(choices, undefined).map((c) => c.value), [1, 2, 3]);
	assert.deepEqual(filterChoices(choices, 'active').map((c) => c.value), [1, 2]);
	assert.deepEqual(filterChoices(choices, 'Active  NET').map((c) => c.value), [2]);
	assert.deepEqual(filterChoices(choices, 'zzz'), []);
});
