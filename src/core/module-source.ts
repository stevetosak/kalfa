// A Module's declarative side: the folder `<name>/` in one of the Module
// folders (the kalfa package's `modules/`, then the machine's `module-dirs`). Skills (`skills/<skill>/SKILL.md`) and rules (`rules/<rule>.md`)
// are found from the folder; `module.yaml` names only what the folder cannot
// say: the Capabilities the Module needs, its command approvals and its pinned
// third-party skills with their Overlays.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';
import { CAPABILITIES, type Capability } from './capabilities.ts';
import { KalfaError } from './errors.ts';
import { readVersioned, type VersionedFormat } from './versioned-file.ts';

export const MODULE_FILE = 'module.yaml';

const name = z.string().regex(/^[a-z][a-z0-9-]*$/, 'a name is lower-case letters, digits and dashes');
const patterns = z.array(z.string().min(1)).default([]);

export const APPROVAL_KINDS = ['allow', 'ask', 'deny'] as const;
export type ApprovalKind = (typeof APPROVAL_KINDS)[number];
export type Approvals = Record<ApprovalKind, string[]>;

const thirdPartySkill = z.strictObject({
	/** The skill's name where it is installed. */
	name,
	/** A git URL. */
	source: z.string().min(1),
	/** The skill folder inside the source repository. */
	path: z
		.string()
		.min(1)
		.refine((path) => !path.startsWith('/') && !path.split('/').includes('..'), 'the skill path stays inside the source repository'),
	commit: z.string().regex(/^[0-9a-f]{40}$/, 'pin a full 40-character commit'),
	/** A Markdown file in the Module folder that is appended to the skill. */
	overlay: z.string().min(1).optional(),
});

export type ThirdPartySkill = z.infer<typeof thirdPartySkill>;

const manifestSchema = z.strictObject({
	schema: z.literal(1),
	description: z.string().min(1),
	/** What the Module does on a harness without each Capability; `kalfa doctor` lists it. */
	needs: z
		.array(z.strictObject({ capability: z.enum(Object.keys(CAPABILITIES) as [Capability, ...Capability[]]), without: z.string().min(1) }))
		.default([]),
	/** Shell command patterns; each Adapter writes them in its harness's own form. */
	commands: z.strictObject({ allow: patterns, ask: patterns, deny: patterns }).default({ allow: [], ask: [], deny: [] }),
	'third-party': z.array(thirdPartySkill).default([]),
});

export type ModuleManifest = z.infer<typeof manifestSchema>;

export const moduleManifestFormat: VersionedFormat<ModuleManifest> = { name: MODULE_FILE, current: 1, schema: manifestSchema };

export interface Rule {
	name: string;
	/** Globs the rule applies to; `undefined` loads it everywhere. */
	paths?: string[];
	body: string;
}

export interface ModuleSource {
	name: string;
	dir: string;
	manifest: ModuleManifest;
	/** Own skills: name and folder. */
	skills: { name: string; dir: string }[];
	rules: Rule[];
}

const ruleHeader = z.strictObject({ paths: z.array(z.string().min(1)).min(1).optional() });
const FRONTMATTER = /^---\n([\s\S]*?)\n---\n?/;

export function parseRule(text: string, ruleName: string, path: string): Rule {
	const normal = text.replace(/\r\n/g, '\n');
	const match = FRONTMATTER.exec(normal);
	if (!match) return { name: ruleName, body: normal };
	const header = ruleHeader.safeParse(parse(match[1]!) ?? {});
	if (!header.success) throw new KalfaError(`${path}: a rule's frontmatter holds only \`paths:\`:\n${z.prettifyError(header.error)}`);
	return { name: ruleName, paths: header.data.paths, body: normal.slice(match[0].length) };
}

const subdirs = (dir: string) => (existsSync(dir) ? readdirSync(dir).filter((entry) => statSync(join(dir, entry)).isDirectory()).sort() : []);
const markdownFiles = (dir: string) => (existsSync(dir) ? readdirSync(dir).filter((entry) => entry.endsWith('.md')).sort() : []);

/** The names of the Modules in `dirs` (each has a `module.yaml`), sorted, each once. */
export function moduleFolders(dirs: readonly string[]): string[] {
	const names = dirs.flatMap((root) => subdirs(root).filter((entry) => existsSync(join(root, entry, MODULE_FILE))));
	return [...new Set(names)].sort();
}

/** The Module `moduleName` from the one folder in `dirs` that holds it, checked. */
export function loadModuleSource(dirs: readonly string[], moduleName: string): ModuleSource {
	const homes = [...new Set(dirs)].filter((root) => existsSync(join(root, moduleName, MODULE_FILE)));
	if (homes.length > 1) throw new KalfaError(`Module '${moduleName}' is in more than one Module folder (${homes.join(', ')}); keep one`);
	if (!homes.length) throw new KalfaError(`unknown Module '${moduleName}' (no ${join(moduleName, MODULE_FILE)} in ${dirs.join(', ')})`);
	const dir = join(homes[0]!, moduleName);
	const manifest = readVersioned(join(dir, MODULE_FILE), moduleManifestFormat)!;

	const skills = subdirs(join(dir, 'skills')).map((skill) => ({ name: skill, dir: join(dir, 'skills', skill) }));
	for (const skill of skills) {
		if (!name.safeParse(skill.name).success) throw new KalfaError(`${skill.dir}: a skill folder name is lower-case letters, digits and dashes`);
		if (!existsSync(join(skill.dir, 'SKILL.md'))) throw new KalfaError(`${skill.dir}: a skill folder needs SKILL.md`);
	}
	const names = [...skills.map((s) => s.name), ...manifest['third-party'].map((s) => s.name)];
	const twice = names.find((n, i) => names.indexOf(n) !== i);
	if (twice) throw new KalfaError(`Module ${moduleName}: the skill name '${twice}' is used twice`);
	for (const pin of manifest['third-party']) {
		if (pin.overlay && !existsSync(join(dir, pin.overlay))) throw new KalfaError(`Module ${moduleName}: overlay ${pin.overlay} does not exist`);
	}

	const rules = markdownFiles(join(dir, 'rules')).map((file) => {
		const path = join(dir, 'rules', file);
		return parseRule(readFileSync(path, 'utf8'), file.slice(0, -3), path);
	});
	return { name: moduleName, dir, manifest, skills, rules };
}
