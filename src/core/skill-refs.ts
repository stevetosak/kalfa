// Skill references in instruction files, and whether an installed skill
// answers them. An instruction file that names a skill no harness has sends
// the agent after something that is not there (a renamed or retired skill), so
// `kalfa doctor` lists each one.
import type { Nodes } from 'mdast';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { gfm } from 'micromark-extension-gfm';
import { basename, dirname } from 'node:path';
import { globSync } from 'tinyglobby';

export interface SkillRef {
	name: string;
	line: number;
}

const NAME = '[a-z][a-z0-9_-]*';
/** `/close-task section`: a slash command, with or without arguments. */
const SLASH = new RegExp(`^/(${NAME}(?::${NAME})?)(?:\\s|$)`);
/** `write-docs` followed by the word "skill" or "skills". */
const BARE = new RegExp(`^${NAME}(?::${NAME})?$`);
const SKILL_WORD = /^\s+skills?\b/i;

/** The skills a Markdown text names: a code span `/name …`, or a code span `name` followed by the word "skill". */
export function skillRefs(markdown: string): SkillRef[] {
	const refs: SkillRef[] = [];
	const walk = (node: Nodes) => {
		if (!('children' in node)) return;
		node.children.forEach((child, i) => {
			if (child.type === 'inlineCode') {
				const line = child.position?.start.line ?? 0;
				const slash = SLASH.exec(child.value);
				const next = node.children[i + 1];
				if (slash?.[1]) refs.push({ name: slash[1], line });
				else if (BARE.test(child.value) && next?.type === 'text' && SKILL_WORD.test(next.value)) refs.push({ name: child.value, line });
			}
			walk(child);
		});
	};
	walk(fromMarkdown(markdown, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] }));
	return refs;
}

/** Where a harness finds skills and commands: a folder and a glob of `SKILL.md` or `<command>.md` files in it. */
export interface SkillSource {
	cwd: string;
	glob: string;
	/** The prefix the harness puts before these names, e.g. a plugin's `commit-commands:`. */
	prefix?: (path: string) => string;
}

/** The names the sources answer: a `SKILL.md` gives its folder's name, any other file its own name. */
export function installedSkills(sources: SkillSource[]): Set<string> {
	const names = new Set<string>();
	for (const source of sources) {
		for (const path of globSync(source.glob, { cwd: source.cwd, onlyFiles: true, expandDirectories: false })) {
			const name = basename(path) === 'SKILL.md' ? basename(dirname(path)) : basename(path, '.md');
			names.add(name);
			if (source.prefix) names.add(`${source.prefix(path)}${name}`);
		}
	}
	return names;
}
