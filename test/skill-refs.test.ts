import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { claudeSkills } from '../src/adapters/claude/skills.ts';
import { installedSkills, skillRefs } from '../src/core/skill-refs.ts';
import { tempRepo } from './helpers.ts';

test('a skill reference is a slash command in a code span, or a code span followed by the word skill', () => {
	const text = [
		'Close a section with `/close-task section` and commit with `/commit-commands:commit`.',
		'Write pages with the `write-docs`',
		'skill, never with `npm run x`.',
		'Paths like `/home/x` and words like `docs` are not references; `grill-me` skills are.',
	].join('\n');
	assert.deepEqual(skillRefs(text), [
		{ name: 'close-task', line: 1 },
		{ name: 'commit-commands:commit', line: 1 },
		{ name: 'write-docs', line: 2 },
		{ name: 'grill-me', line: 4 },
	]);
});

test("Claude Code's skills: the repository's, the user's, and the plugins' with and without their prefix", () => {
	const home = tempRepo({
		'.claude/skills/grill-me/SKILL.md': 'x',
		'.claude/commands/meter.md': 'x',
		'.claude/plugins/cache/market/commit-commands/abc123/commands/commit.md': 'x',
		'.claude/plugins/cache/market/skill-creator/abc123/skills/skill-creator/SKILL.md': 'x',
	});
	const root = tempRepo({ '.claude/skills/push-gate/SKILL.md': 'x', '.claude/skills/no-skill-file/notes.md': 'x' });
	assert.deepEqual(
		[...installedSkills(claudeSkills.sources(home, root))].sort(),
		['commit', 'commit-commands:commit', 'grill-me', 'meter', 'push-gate', 'skill-creator', 'skill-creator:skill-creator'],
	);
	assert.deepEqual([...installedSkills(claudeSkills.sources(join(home, 'none'), join(root, 'none')))], []);
});
