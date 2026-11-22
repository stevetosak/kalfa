// The Instruction files of a layer's Rule pack (ADR 0003): the pack in the
// form the harness loads, at the paths its Adapter's RuleLayout gives. A
// harness without a feature loads more, never less: without `path-rules` a
// path-scoped rule loads always, and without `skills` a skill-form rule
// becomes a pointer line among the rules that load always. `kalfa build`
// writes a project's files (with the Modules' files, recorded in build.yaml);
// `kalfa install`, each `kalfa rule` write and each session start write the
// Personal layer's (user-files.ts).
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LayerRules, LoadedRule, RuleLayout } from '../../adapters/adapter.ts';
import type { Capability } from '../capabilities.ts';
import type { Layer } from '../memory/home.ts';
import { type PackRule, packSkillDir, SKILL_FILE } from './pack.ts';

/** A skill-form rule where the harness finds skills: its folder in the pack and its folder for the harness (relative to the base). */
export interface PlannedSkill {
	name: string;
	source: string;
	target: string;
}

export interface PlannedRules {
	/** The Instruction files by path relative to the base folder (HOME or the repository root). */
	files: Map<string, string>;
	skills: PlannedSkill[];
	/** The rules as they load, for the session report when the files are not there. */
	rules: LayerRules;
}

function indent(text: string): string {
	return text
		.split('\n')
		.map((line) => (line ? `  ${line}` : line))
		.join('\n');
}

/** One rule as a list item: its first line, the rest indented under it, and its id. */
export const ruleItem = (rule: LoadedRule): string => `- ${indent(rule.text).trimStart()} (${rule.id})`;

/** The line a skill-form rule loads as where the harness has no skills. */
function pointer(layer: Layer, rule: PackRule): LoadedRule {
	const file = join(packSkillDir(layer, rule.id), SKILL_FILE);
	return { id: rule.id, text: `When the work is this: ${rule.description} Read the procedure in ${file} first.` };
}

/** The rules of a layer as a harness with `capabilities` loads them. */
export function loadedRules(layer: Layer, pack: readonly PackRule[], capabilities: ReadonlySet<Capability>): LayerRules & { skills: PackRule[] } {
	const always: LoadedRule[] = [];
	const scoped: LoadedRule[] = [];
	const skills: PackRule[] = [];
	for (const rule of pack) {
		if (rule.form === 'always') always.push({ id: rule.id, text: rule.text });
		else if (rule.form === 'path' && capabilities.has('path-rules')) scoped.push({ id: rule.id, text: rule.text, paths: rule.paths });
		else if (rule.form === 'path') always.push({ id: rule.id, text: `${rule.text}\n(It applies to the files that match ${rule.paths!.join(', ')}.)` });
		else if (capabilities.has('skills')) skills.push(rule);
		else always.push(pointer(layer, rule));
	}
	return { layer: layer.name, label: layer.label, always, scoped, skills };
}

/** What a layer's Instruction files are for a harness with `capabilities` and `layout`. */
export function planRuleFiles(layer: Layer, pack: readonly PackRule[], layout: RuleLayout, capabilities: ReadonlySet<Capability>): PlannedRules {
	const { skills, ...rules } = loadedRules(layer, pack, capabilities);
	const files = new Map(layout.files(rules).map(({ path, text }) => [path, text]));
	return { files, skills: skills.map((rule) => ({ name: rule.id, source: packSkillDir(layer, rule.id), target: layout.skillDir(rule.id) })), rules };
}

/** The rules for the session report, when the harness cannot load them from files; empty when the layer has none. */
export function rulesReport(rules: LayerRules, why: string): string {
	const items = [...rules.always, ...rules.scoped.map((rule) => ({ ...rule, text: `${rule.text}\n(It applies to the files that match ${rule.paths!.join(', ')}.)` }))];
	if (!items.length) return '';
	const title = rules.layer === 'personal' ? 'the Personal layer' : `the Project layer (${rules.label})`;
	return [`Rules of ${title} (its Rule pack; ${why}):`, ...items.map(ruleItem)].join('\n');
}

/** The planned files that are missing or differ under `base`, by path. */
export function staleFiles(base: string, files: ReadonlyMap<string, string>): { missing: string[]; changed: string[] } {
	const missing: string[] = [];
	const changed: string[] = [];
	for (const [path, text] of files) {
		const full = join(base, path);
		if (!existsSync(full)) missing.push(path);
		else if (readFileSync(full, 'utf8') !== text) changed.push(path);
	}
	return { missing, changed };
}
