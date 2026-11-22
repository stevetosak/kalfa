import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseRecord } from '../../src/core/task-record.ts';
import { CLOSE_LABEL, cleanupSteps, rememberFindings, splitFindings, type Upkeep } from './cleanup.ts';

const TASK = { id: 'feat-x', key: 'github.com/someone/project' };

test('splitFindings takes one finding per top-level bullet, and none for "none"', () => {
	assert.deepEqual(splitFindings('- first\n  more of first\n- second'), ['first\n  more of first', 'second']);
	assert.deepEqual(splitFindings('One plain finding.'), ['One plain finding.']);
	assert.deepEqual(splitFindings('none'), []);
	assert.deepEqual(splitFindings('- None.\n- real'), ['real']);
});

test('rememberFindings takes each Section in order, then the closing parts, and the old part names too', () => {
	const record = parseRecord(
		[
			'---\nschema: 1\ngoal: g\nstatus: closed\nstarted: 2026-11-22\nclosed: 2026-11-22\n---',
			'## Section: First\n\n**Done:** a\n\n**Memory candidates:** - one\n- two',
			'## Section: Second\n\n**Done:** b',
			'## Section: Third\n\n**Done:** c\n\n**Remember:** three',
			'## Close\n\n**Remember:** - four',
		].join('\n\n'),
		'feat-x.md',
		'feat-x',
	);
	assert.deepEqual(rememberFindings(record), [
		{ from: 'First', text: 'one' },
		{ from: 'First', text: 'two' },
		{ from: 'Third', text: 'three' },
		{ from: CLOSE_LABEL, text: 'four' },
	]);
});

test('the Cleanup lists each finding on one line, the Task as the source, and ends with the reconciled command', () => {
	const steps = cleanupSteps(TASK, [{ from: 'First', text: 'one\n  more of one' }], []).split('\n');
	assert.match(steps[0]!, /^Cleanup of Task feat-x \(ADR 0003\).*do not ask the Operator\.$/);
	assert.ok(steps.includes('- First: one more of one'), steps.join('\n'));
	assert.ok(steps.some((l) => l.includes('--source "Task feat-x (github.com/someone/project)"')));
	assert.ok(steps.some((l) => l.includes('kalfa rule add')), 'a finding that is a rule goes to its Rule pack');
	assert.ok(steps.some((l) => l.includes('Hub of its subject')), 'each finding is linked into its Hub');
	assert.equal(steps.at(-1), 'Then mark the record: `kalfa task reconciled --task feat-x`.');
	assert.ok(!steps.some((l) => l.startsWith('Memory upkeep')), 'no layer over its budget, no upkeep');
});

test('a record with no finding still gets the reconciled command, and the upkeep comes before it', () => {
	const upkeep: Upkeep[] = [{ layer: 'personal', problem: 'the personal layer holds 9000 B', duplicates: [], open: [{ id: 'old-item', summary: 'Old work.' }] }];
	const steps = cleanupSteps(TASK, [], upkeep).split('\n');
	assert.equal(steps[1], 'Its Sections have no finding in a Remember part.');
	assert.ok(!steps.some((l) => l.startsWith('For each finding')));
	const upkeepAt = steps.findIndex((l) => l.startsWith('Memory upkeep'));
	assert.ok(upkeepAt > 1 && steps.includes('  - open item personal/old-item: Old work.'), steps.join('\n'));
	assert.equal(steps.at(-1), 'Then mark the record: `kalfa task reconciled --task feat-x`.');
});
