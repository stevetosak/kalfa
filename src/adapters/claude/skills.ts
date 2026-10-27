// Where Claude Code finds skills and slash commands: the repository's and the
// user's `.claude/skills/` and `.claude/commands/`, and the installed plugins,
// whose names also answer with the plugin's prefix (`commit-commands:commit`).
import { join } from 'node:path';
import type { SkillLookup } from '../adapter.ts';

/** A plugin's files sit at `<marketplace>/<plugin>/<version>/…` in the plugin cache. */
const pluginPrefix = (path: string) => `${path.split('/')[1]}:`;

export const claudeSkills: SkillLookup = {
	sources: (home, root) => [
		{ cwd: join(root, '.claude'), glob: 'skills/*/SKILL.md' },
		{ cwd: join(root, '.claude'), glob: 'commands/**/*.md' },
		{ cwd: join(home, '.claude'), glob: 'skills/*/SKILL.md' },
		{ cwd: join(home, '.claude'), glob: 'commands/**/*.md' },
		{ cwd: join(home, '.claude', 'plugins', 'cache'), glob: '*/*/*/skills/*/SKILL.md', prefix: pluginPrefix },
		{ cwd: join(home, '.claude', 'plugins', 'cache'), glob: '*/*/*/commands/*.md', prefix: pluginPrefix },
	],
	// The built-in commands of Claude Code 2.1.311 that instruction files name; a newer one shows as not found.
	builtins: new Set(['agents', 'clear', 'compact', 'config', 'context', 'cost', 'doctor', 'effort', 'export', 'fast', 'help', 'hooks', 'init', 'login', 'logout', 'mcp', 'memory', 'model', 'permissions', 'plugin', 'resume', 'review', 'rewind', 'status', 'usage']),
};
