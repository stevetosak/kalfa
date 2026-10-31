import assert from 'node:assert/strict';
import { test } from 'node:test';
import { handoffView, parseRecord, renderRecord, sectionParts, taskIdOf, type TaskRecord } from '../src/core/task-record.ts';

test('a Task id comes from the branch name', () => {
	assert.equal(taskIdOf('feat/monitoring'), 'feat-monitoring');
	assert.equal(taskIdOf('fix/a b//c'), 'fix-a-b-c');
});

test('a Section is split into its parts, multi-line parts included', () => {
	const parts = sectionParts('**Done:** proved it.\n\n**Found:**\n- one. Proof: x.\n- two.\n\n**docs.pages:** the runbook\n', ['docs']);
	assert.deepEqual([...parts], [['Done', 'proved it.'], ['Found', '- one. Proof: x.\n- two.'], ['docs.pages', 'the runbook']]);
});

const refusals: Array<[string, string, RegExp]> = [
	['no Done part', '**Found:** x\n', /needs a \*\*Done:\*\* part/],
	['text before the first part', 'hello\n**Done:** x\n', /text before the first part/],
	['an unknown part', '**Done:** x\n**Pages:** y\n', /unknown part \*\*Pages:\*\*/],
	['a part of a Module that is off', '**Done:** x\n**meter.cost:** y\n', /Module meter is not enabled/],
	['a part given twice', '**Done:** x\n**Done:** y\n', /given twice/],
	['an empty part', '**Done:**\n\n**Next:** y\n', /\*\*Done:\*\* is empty/],
];

for (const [what, text, message] of refusals) {
	test(`a Section with ${what} is refused`, () => {
		assert.throws(() => sectionParts(text, ['docs']), { name: 'KalfaError', message });
	});
}

const record: Omit<TaskRecord, 'id' | 'path'> = {
	header: { schema: 1, goal: 'Build the monitoring', branch: 'feat/monitoring', status: 'open', started: '2026-10-27' },
	sections: [
		{ title: 'platforms proven', parts: new Map([['Done', 'proved.'], ['Found', '- probes pass. Proof: 200.'], ['Memory candidates', '- a check needs a clean state.'], ['Next', 'render.']]) },
		{ title: 'render', parts: new Map([['Done', 'rendered.'], ['Next', 'apply it.']]) },
	],
};

test('a record survives a render and a parse unchanged', () => {
	const text = renderRecord(record);
	assert.match(text, /^---\nschema: 1\ngoal: Build the monitoring\n[\s\S]*---\n\n## Section: platforms proven\n\n\*\*Done:\*\* proved\./);
	assert.deepEqual(parseRecord(text, '/r.md', 'feat-monitoring'), { ...record, id: 'feat-monitoring', path: '/r.md' });
});

test('a record of a newer schema is refused', () => {
	assert.throws(() => parseRecord(renderRecord({ ...record, header: { ...record.header, schema: 2 as 1 } }), '/r.md', 'x'), { message: /newer than this kalfa reads/ });
});

test('the Handoff view holds the goal, the Sections, the last findings, the candidates and the next step', () => {
	const view = handoffView({ ...record, id: 'feat-monitoring', path: '/r.md' });
	assert.match(view, /^Task feat-monitoring: Build the monitoring \(open\)\nRecord: \/r\.md\nSections closed: platforms proven; render/);
	assert.match(view, /Memory candidates:\n- a check needs a clean state\./);
	assert.match(view, /Next: apply it\.$/);
	assert.doesNotMatch(view, /probes pass/, 'Found comes from the last Section only');
});

test('an old record with Lesson candidates reads them as Memory candidates', () => {
	const old = renderRecord(record).replace('**Memory candidates:**', '**Lesson candidates:**');
	assert.equal(parseRecord(old, '/r.md', 'x').sections[0]!.parts.get('Memory candidates'), '- a check needs a clean state.');
});
