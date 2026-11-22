// A layer's Rule pack (ADR 0003): the layer's rules, kept apart from its
// Memory records, in the same folder of the Memory home and under the same git
// history. `rules/<id>.md` is a rule that loads always, or only by path with
// `paths:` (the file format of a Module's Rule pack); `skills/<id>/SKILL.md`
// is a rule that is a procedure, a skill. A rule's text starts with the rule
// in one line; the lines after it give its reasons. `kalfa rule` writes the
// pack, and kalfa writes it as the harness's Instruction files (files.ts).
import { existsSync, readdirSync, readFileSync, rmdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import picomatch from 'picomatch';
import { parse, stringify } from 'yaml';
import { z } from 'zod';
import { KalfaError } from '../errors.ts';
import { commitHome, type HomeChange, type Layer } from '../memory/home.ts';
import { recordId } from '../memory/record.ts';
import { parseRule } from '../module-source.ts';

/** How a rule loads: in every session, when the agent works on a file its paths match, or as a skill when the work fits it. */
export const RULE_FORMS = ['always', 'path', 'skill'] as const;
export type RuleForm = (typeof RULE_FORMS)[number];

export interface PackRule {
	id: string;
	form: RuleForm;
	/** The rule in its first line, its reasons after it; a skill's procedure. */
	text: string;
	/** The globs of a path-scoped rule, relative to the folder the session runs in. */
	paths?: string[];
	/** A skill's description: the work it applies to. */
	description?: string;
}

/** What `kalfa rule` checks a rule against. */
export interface RuleLimits {
	/** The most characters of a rule that loads always or by path. */
	ruleChars: number;
}

export const SKILL_FILE = 'SKILL.md';
/** A harness finds a skill by its folder name; the common limit on it. */
const SKILL_NAME_MAX = 64;
const DESCRIPTION_MAX = 500;

export const packRulesDir = (layer: Layer) => join(layer.dir, 'rules');
export const packSkillsDir = (layer: Layer) => join(layer.dir, 'skills');
export const packSkillDir = (layer: Layer, id: string) => join(packSkillsDir(layer), id);

/** The file that holds a rule of the given form. */
export function packPath(layer: Layer, id: string, form: RuleForm): string {
	return form === 'skill' ? join(packSkillDir(layer, id), SKILL_FILE) : join(packRulesDir(layer), `${id}.md`);
}

const frontmatter = (data: Record<string, unknown>) => `---\n${stringify(data).trimEnd()}\n---\n\n`;

/** The text of a rule's file in the pack. */
export function packText(rule: PackRule): string {
	const body = `${rule.text.trim()}\n`;
	if (rule.form === 'path') return `${frontmatter({ paths: rule.paths })}${body}`;
	if (rule.form === 'skill') return `${frontmatter({ name: rule.id, description: rule.description })}${body}`;
	return body;
}

const skillHeader = z.looseObject({ name: z.string().min(1), description: z.string().trim().min(1) });
const FRONTMATTER = /^---\n([\s\S]*?)\n---\n?/;

function readSkill(dir: string, id: string): PackRule {
	const path = join(dir, SKILL_FILE);
	if (!existsSync(path)) throw new KalfaError(`${dir}: a skill-form rule needs ${SKILL_FILE}`);
	const text = readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
	const match = FRONTMATTER.exec(text);
	const header = skillHeader.safeParse(match ? (parse(match[1]!) ?? {}) : {});
	if (!header.success) throw new KalfaError(`${path}: a skill starts with a --- header --- that has name and description`);
	if (header.data.name !== id) throw new KalfaError(`${path}: the skill's name is '${header.data.name}', its folder '${id}'; they must be the same`);
	return { id, form: 'skill', text: text.slice(match![0].length).trim(), description: header.data.description };
}

const entries = (dir: string) => (existsSync(dir) ? readdirSync(dir).sort() : []);

export interface PackScan {
	rules: PackRule[];
	/** One message per file that is not a valid rule; such a file is left out. */
	problems: string[];
}

/** Every rule of the layer's pack; a file that is not a valid rule is reported and left out. */
export function scanPack(layer: Layer): PackScan {
	const scan: PackScan = { rules: [], problems: [] };
	const add = (read: () => PackRule) => {
		try {
			const rule = read();
			if (!recordId.safeParse(rule.id).success) throw new KalfaError(`${layer.label}: '${rule.id}' is not a rule id (lower-case letters, digits and dashes)`);
			if (scan.rules.some((r) => r.id === rule.id)) throw new KalfaError(`${layer.label}: the rule '${rule.id}' is both a rule file and a skill; keep one`);
			scan.rules.push(rule);
		} catch (error) {
			if (!(error instanceof KalfaError)) throw error;
			scan.problems.push(error.message);
		}
	};
	for (const name of entries(packRulesDir(layer)).filter((n) => n.endsWith('.md'))) {
		const path = join(packRulesDir(layer), name);
		add(() => {
			const rule = parseRule(readFileSync(path, 'utf8'), name.slice(0, -3), path);
			const text = rule.body.trim();
			return rule.paths ? { id: rule.name, form: 'path', text, paths: rule.paths } : { id: rule.name, form: 'always', text };
		});
	}
	for (const name of entries(packSkillsDir(layer)).filter((n) => statSync(join(packSkillsDir(layer), n)).isDirectory())) {
		add(() => readSkill(packSkillDir(layer, name), name));
	}
	return scan;
}

/** Every rule of the pack; refused when a file is not a valid rule (a write must see the whole pack). */
export function readPack(layer: Layer): PackRule[] {
	const { rules, problems } = scanPack(layer);
	if (problems.length) throw new KalfaError(`${problems.join('; ')} (fix the file by hand, then try again)`);
	return rules;
}

/** Why a glob cannot be a rule's path pattern, or `undefined` when it can. */
function badPattern(glob: string): string | undefined {
	if (!glob.trim() || /\n/.test(glob)) return 'it is empty or holds a line break';
	if (glob.startsWith('/') || glob.startsWith('~')) return 'it must be relative to the folder the session runs in';
	if (glob.split('/').includes('..')) return 'it must not leave that folder (..)';
	try {
		picomatch.makeRe(glob);
	} catch (error) {
		return (error as Error).message;
	}
	return undefined;
}

/** Checks a rule before it is written: its id, its length, its path patterns and its skill description. */
export function checkPackRule(rule: PackRule, limits: RuleLimits): PackRule {
	if (!recordId.safeParse(rule.id).success) throw new KalfaError(`'${rule.id}' is not a rule id: lower-case letters, digits and dashes, at most 80`);
	const text = rule.text.trim();
	if (!text) throw new KalfaError('a rule needs its text');
	if (rule.form === 'skill') {
		if (rule.id.length > SKILL_NAME_MAX) throw new KalfaError(`a skill's id is at most ${SKILL_NAME_MAX} characters; '${rule.id}' has ${rule.id.length}`);
		const description = rule.description?.trim() ?? '';
		if (!description || description.includes('\n')) throw new KalfaError('a skill needs a description in one line: the work it applies to');
		if (description.length > DESCRIPTION_MAX) throw new KalfaError(`a skill's description is at most ${DESCRIPTION_MAX} characters; this one has ${description.length}`);
		return { id: rule.id, form: 'skill', text, description };
	}
	if (text.length > limits.ruleChars) {
		throw new KalfaError(`a rule is short and exact: this one is ${text.length} characters (limit ${limits.ruleChars}); move the reasons into a Memory record, or make the rule a skill if it is a procedure`);
	}
	if (rule.form === 'always') return { id: rule.id, form: 'always', text };
	const paths = rule.paths ?? [];
	if (!paths.length) throw new KalfaError('a path-scoped rule needs at least one path pattern');
	for (const glob of paths) {
		const why = badPattern(glob);
		if (why) throw new KalfaError(`the path pattern '${glob}' is not valid: ${why}`);
	}
	return { id: rule.id, form: 'path', text, paths };
}

/** The pack's files of a rule, inside its folder, for a removal. */
function filesOf(layer: Layer, rule: PackRule): string[] {
	if (rule.form !== 'skill') return [packPath(layer, rule.id, rule.form)];
	const dir = packSkillDir(layer, rule.id);
	return (readdirSync(dir, { recursive: true }) as string[]).map((entry) => join(dir, entry)).filter((path) => statSync(path).isFile());
}

/** A change of one layer's pack: rules to write (new or replaced), and rules to remove as they are now. */
export interface PackChange {
	layer: Layer;
	write?: PackRule[];
	remove?: PackRule[];
}

/**
 * Writes and removes rules in the Memory home as one commit, with any other
 * change of the home (`also`, e.g. the Memory records a migration closes). A
 * rule that changes its form loses the file of its old form.
 */
export function commitPack(home: string, changes: PackChange[], message: string, also: HomeChange = {}): void {
	const write = changes.flatMap(({ layer, write = [] }) => write.map((rule) => ({ path: packPath(layer, rule.id, rule.form), text: packText(rule) })));
	const written = new Set(write.map((w) => w.path));
	const remove = changes.flatMap(({ layer, remove = [] }) => remove.flatMap((rule) => filesOf(layer, rule))).filter((path) => !written.has(path));
	commitHome(home, { write: [...write, ...(also.write ?? [])], remove: [...remove, ...(also.remove ?? [])] }, message);
	// A skill folder left empty goes, so the pack does not hold a skill with no SKILL.md.
	for (const { layer, remove = [] } of changes) {
		for (const rule of remove.filter((r) => r.form === 'skill')) removeEmptyDirs(packSkillDir(layer, rule.id));
	}
}

function removeEmptyDirs(dir: string): void {
	if (!existsSync(dir)) return;
	for (const entry of readdirSync(dir)) {
		const path = join(dir, entry);
		if (statSync(path).isDirectory()) removeEmptyDirs(path);
	}
	if (!readdirSync(dir).length) rmdirSync(dir);
}
