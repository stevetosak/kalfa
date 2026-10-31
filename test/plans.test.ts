import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findPlans, openAnywhere, parsePlan, planStepProblems, planSummary, progressOf, readPlanSteps } from '../src/core/plans.ts';
import { tempRepo } from './helpers.ts';

const page = (status: string, body: string, extra = '') => `---\ntitle: Rebuild\ndescription: kept for the site\ntype: plan\nstatus: ${status}\n${extra}---\n\n${body}`;

const BODY = [
	'Intro prose.',
	'',
	'- a plain list item is prose',
	'',
	'## Phase 1',
	'',
	'**Done when:** the monitoring',
	'stack renders.',
	'',
	'- [x] **Rotate** the token.',
	'- [ ] **Monitoring** (ADR 0011):',
	'  - [x] prove Access',
	'  - [ ] render core/monitoring',
	'- [ ] ~~Old idea~~ replaced by the one above.',
	'',
	'```',
	'- [ ] a step inside a code fence is not a step',
	'```',
	'',
	'## Phase 2',
	'',
	'**Done when:** v1 is tagged.',
	'',
	'- [ ] Tag the release.',
	'',
].join('\n');

test('steps, groups, sub-items and dropped steps follow the Contract format', () => {
	const { steps, unknownMarks } = readPlanSteps(BODY);
	assert.deepEqual(unknownMarks, []);
	assert.deepEqual(
		steps.map((s) => [s.state, s.label, s.group]),
		[
			['done', 'Rotate', 'Phase 1'],
			['open', 'Monitoring', 'Phase 1'],
			['dropped', 'Old idea replaced by the one above.', 'Phase 1'],
			['open', 'Tag the release.', 'Phase 2'],
		],
	);
	assert.deepEqual(steps[1]!.subItems.map((s) => [s.state, s.text]), [['done', 'prove Access'], ['open', 'render core/monitoring']]);
	assert.deepEqual(progressOf(steps), { done: 1, open: 2, dropped: 1, total: 3 });
	assert.deepEqual(openAnywhere(steps).map((s) => s.text), ['Monitoring (ADR 0011):', 'render core/monitoring', 'Tag the release.']);
});

test('line numbers count the frontmatter, so they match the file', () => {
	const plan = parsePlan(page('active', BODY), 'docs/plan.md')!;
	const text = page('active', BODY).split('\n');
	for (const step of plan.steps) assert.match(text[step.line - 1]!, /^- \[[ x]\]/);
});

test('a page of another type, or without frontmatter, is not a Plan', () => {
	assert.equal(parsePlan('---\ntype: log\ntitle: x\n---\n- [ ] y\n', 'a.md'), undefined);
	assert.equal(parsePlan('# Just a page\n- [ ] y\n', 'a.md'), undefined);
});

test('a Plan with a bad status or no title is refused', () => {
	assert.throws(() => parsePlan(page('ongoing', BODY), 'p.md'), { name: 'KalfaError', message: /p\.md: the Plan frontmatter is not valid:[\s\S]*status/ });
	assert.throws(() => parsePlan('---\ntype: plan\nstatus: active\n---\n', 'p.md'), { message: /title/ });
	assert.throws(() => parsePlan('---\ntype: [plan\n---\n', 'p.md'), { message: /p\.md: the frontmatter is not valid YAML/ });
});

test('the format rules: unknown marks, an open Plan without steps, a done Plan with open steps', () => {
	const unknown = parsePlan(page('active', '**Done when:** x.\n\n- [~] half done\n- [ ] real\n'), 'p.md')!;
	assert.deepEqual(planStepProblems(unknown), ['line 10: "[~]" is not a step mark; use "- [ ]" or "- [x]", and strike a dropped step\'s text with ~~ ~~.']);
	assert.deepEqual(planStepProblems(parsePlan(page('proposed', 'No steps yet.\n'), 'p.md')!), ['an open Plan needs at least one step (a "- [ ]" task item).']);
	assert.match(planStepProblems(parsePlan(page('done', BODY), 'p.md')!)[0]!, /a done Plan has 3 open step\(s\), first at line 18/);
	assert.deepEqual(planStepProblems(parsePlan(page('abandoned', BODY), 'p.md')!), []);
});

test('each part keeps its finish line: a ## group, or the steps above the first heading', () => {
	assert.deepEqual(
		readPlanSteps(BODY).parts.map((p) => [p.group, p.line, p.doneWhen, p.steps.length]),
		[
			['Phase 1', 5, 'the monitoring stack renders.', 3],
			['Phase 2', 20, 'v1 is tagged.', 1],
		],
	);
	const flat = readPlanSteps('Intro.\n\n**Done when:** it ships.\n\n- [ ] Ship it.\n');
	assert.deepEqual(flat.parts.map((p) => [p.group, p.line, p.doneWhen]), [[undefined, 3, 'it ships.']]);
	// A bold word that is not the label, or a heading with no steps, makes no finish line or part.
	assert.deepEqual(readPlanSteps('## Notes\n\nProse.\n\n## Work\n\n**Done** when it ships.\n\n- [ ] Ship.\n').parts.map((p) => [p.group, p.doneWhen]), [['Work', undefined]]);
});

test('an open part of an open Plan needs a finish line; a finished part or a closed Plan does not', () => {
	const body = '## Old\n\n- [x] Done long ago.\n\n## New\n\n- [ ] Open work.\n- [x] Done work.\n';
	assert.deepEqual(planStepProblems(parsePlan(page('active', body), 'p.md')!), [
		'line 12: the part "New" has open steps and no finish line; add a "**Done when:** …" paragraph above its steps.',
	]);
	assert.deepEqual(planStepProblems(parsePlan(page('proposed', '- [ ] Open.\n'), 'p.md')!), [
		'line 8: the part above the first ## heading has open steps and no finish line; add a "**Done when:** …" paragraph above its steps.',
	]);
	assert.deepEqual(planStepProblems(parsePlan(page('abandoned', body), 'p.md')!), []);
	assert.deepEqual(planStepProblems(parsePlan(page('active', BODY), 'p.md')!), []);
});

test('the summary gives progress and the next step with its first open sub-item', () => {
	assert.equal(
		planSummary(parsePlan(page('active', BODY), 'docs/plan.md')!),
		'- Rebuild (active, 1 of 3 steps done; docs/plan.md)\n  Next: Monitoring → render core/monitoring',
	);
	assert.equal(planSummary(parsePlan(page('active', '- [x] all\n'), 'p.md')!), '- Rebuild (active, 1 of 1 steps done; p.md)');
});

test('findPlans reads matched pages, skips other types and ignored folders, and keeps going past a broken page', () => {
	const root = tempRepo({
		'docs/plan.md': page('active', BODY),
		'docs/runbook/old.md': page('done', '- [x] done\n'),
		'docs/log.md': '---\ntype: log\n---\n',
		'docs/broken.md': page('ongoing', ''),
		'node_modules/pkg/plan.md': page('active', '- [ ] not ours\n'),
		'.kalfa/tasks/plan.md': page('active', '- [ ] private\n'),
	});
	const { plans, problems } = findPlans(root, ['docs/**/*.md', '**/plan.md', 'missing/*.md']);
	assert.deepEqual(plans.map((p) => [p.path, p.status]), [['docs/plan.md', 'active'], ['docs/runbook/old.md', 'done']]);
	assert.equal(problems.length, 2);
	assert.match(problems[0]!, /plans glob 'missing\/\*\.md' matches no file/);
	assert.match(problems[1]!, /docs\/broken\.md: the Plan frontmatter is not valid/);
});
