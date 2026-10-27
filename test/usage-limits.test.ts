import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { checkLimits, limitsPath, saveLimits } from '../src/core/usage-limits.ts';
import { tempDir } from './helpers.ts';

test('the saved limits refuse a new session near a limit, and say nothing when unknown or stale', () => {
	const path = join(tempDir(), 'kalfa', 'usage-limits.json');
	const now = Date.UTC(2026, 9, 27, 12);
	assert.match((checkLimits(path, now) as { note: string }).note, /unknown \(nothing saved them\)/);
	const save = (age: number, five: number) => saveLimits(path, { five_hour: { used_percentage: five, resets_at: now / 1000 + 3600 }, seven_day: { used_percentage: 20 } }, now - age);
	save(60_000, 40);
	assert.deepEqual(checkLimits(path, now), { ok: true, note: 'five_hour 40%, seven_day 20%' });
	save(60_000, 94);
	const refused = checkLimits(path, now);
	assert.equal(refused.ok, false);
	assert.match(refused.ok ? '' : refused.reason, /^five_hour at 94%, resets /);
	save(31 * 60_000, 94);
	assert.match((checkLimits(path, now) as { note: string }).note, /stale/);
	writeFileSync(path, '{not json');
	assert.match((checkLimits(path, now) as { note: string }).note, /is not a limits file/);
});

test('the limits file is in the cache folder', () => {
	assert.equal(limitsPath({ HOME: '/h' }), '/h/.cache/kalfa/usage-limits.json');
	assert.equal(limitsPath({ HOME: '/h', XDG_CACHE_HOME: '/c' }), '/c/kalfa/usage-limits.json');
});
