// Where Claude Code reads a Module's files in a repository: skills in
// `.claude/skills/`, rules in `.claude/rules/` (with `paths:` for a scoped
// rule), and command approvals in the `permissions` lists of
// `.claude/settings.local.json`, next to the Operator's own entries.
import { stringify } from 'yaml';
import type { ProjectFiles } from '../adapter.ts';

const generated = (module: string) => `<!-- Written by kalfa build from the Module '${module}'. Change the Module, not this file. -->`;

const permissions = (data: Record<string, unknown>): Record<string, unknown> => {
	const value = data.permissions;
	return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
};

export const claudeProject: ProjectFiles = {
	skillDir: (skill) => `.claude/skills/${skill}`,
	rule(module, rule) {
		const header = rule.paths ? `---\n${stringify({ paths: rule.paths }).trimEnd()}\n---\n` : '';
		return { path: `.claude/rules/kalfa-${module}-${rule.name}.md`, text: `${header}${generated(module)}\n\n${rule.body}` };
	},
	approvals: {
		path: '.claude/settings.local.json',
		entry: (pattern) => `Bash(${pattern})`,
		read(data, kind) {
			const list = permissions(data)[kind];
			return Array.isArray(list) ? list.filter((e): e is string => typeof e === 'string') : [];
		},
		write(data, kind, entries) {
			const next = { ...permissions(data) };
			if (entries.length) next[kind] = entries;
			else delete next[kind];
			const result: Record<string, unknown> = { ...data, permissions: next };
			if (!Object.keys(next).length) delete result.permissions;
			return result;
		},
	},
};
