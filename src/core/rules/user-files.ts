// The Personal layer's Instruction files in a harness's user folder (ADR
// 0003). The rules folder the Adapter names is kalfa's alone, so kalfa writes
// every file in it and removes every other; a skill-form rule is a link to its
// folder in the pack, and only the links `install.yaml` records are kalfa's.
// `kalfa install` writes them and records them; after that each `kalfa rule`
// write and each session start write them again, so the next session has the
// current rules.
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmdirSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { RuleLayout } from '../../adapters/adapter.ts';
import type { Capability } from '../capabilities.ts';
import { memoryHome, personalLayer } from '../memory/home.ts';
import { type PlannedRules, planRuleFiles } from './files.ts';
import { scanPack } from './pack.ts';

/** What kalfa owns of the Personal layer's Instruction files: the rules folder and the skill links, relative to HOME. */
export interface OwnedRules {
	dir: string;
	skills: string[];
}

export interface UserRulesResult {
	report: string[];
	changed: boolean;
	owned?: OwnedRules;
}

/** Every file under `dir`, relative to `base`. */
function filesUnder(base: string, dir: string): string[] {
	const full = join(base, dir);
	if (!existsSync(full)) return [];
	return (readdirSync(full, { recursive: true }) as string[]).map((entry) => join(dir, entry)).filter((path) => statSync(join(base, path)).isFile());
}

function removeEmptyDirs(base: string, dir: string): void {
	const full = join(base, dir);
	if (!existsSync(full) || !statSync(full).isDirectory()) return;
	for (const entry of readdirSync(full)) removeEmptyDirs(base, join(dir, entry));
	if (!readdirSync(full).length) rmdirSync(full);
}

function removeIfEmpty(dir: string): void {
	if (existsSync(dir) && statSync(dir).isDirectory() && !readdirSync(dir).length) rmdirSync(dir);
}

const isLink = (path: string) => {
	try {
		return lstatSync(path).isSymbolicLink();
	} catch {
		return false;
	}
};

/** A path that is there in any form, a broken link too. */
const present = (path: string) => existsSync(path) || isLink(path);

/**
 * Brings the Personal layer's Instruction files under `home` to `planned`;
 * `planned` left out removes what kalfa owns. Never touches a file outside the
 * rules folder that kalfa did not record.
 */
export function applyUserRules(home: string, layout: RuleLayout, planned: PlannedRules | undefined, owned: OwnedRules | undefined, dryRun: boolean): UserRulesResult {
	const report: string[] = [];
	const dir = layout.dir('personal');
	const wanted = planned?.files ?? new Map<string, string>();
	const writes = [...wanted].filter(([path, text]) => !existsSync(join(home, path)) || readFileSync(join(home, path), 'utf8') !== text);
	const dirs = [...new Set([dir, ...(owned && owned.dir !== dir ? [owned.dir] : [])])];
	const removals = dirs.flatMap((d) => filesUnder(home, d)).filter((path) => !wanted.has(path));
	for (const [path] of writes) report.push(`rules: write ${join(home, path)}${existsSync(join(home, path)) ? ' (it differs from the Rule pack)' : ''}`);
	for (const path of removals) report.push(`rules: remove ${join(home, path)}`);

	// Skills: a link to the pack's folder; a path kalfa did not link stays as it is.
	const links: string[] = [];
	const linkWrites: Array<{ target: string; source: string }> = [];
	for (const skill of planned?.skills ?? []) {
		const target = join(home, skill.target);
		const ours = owned?.skills.includes(skill.target) ?? false;
		if (present(target) && !(ours && isLink(target))) {
			report.push(`skills: ${target} exists and kalfa did not link it; the skill '${skill.name}' is not linked`);
			continue;
		}
		links.push(skill.target);
		if (isLink(target) && readlinkSync(target) === skill.source) continue;
		report.push(`skills: link ${target} → ${skill.source}`);
		linkWrites.push({ target, source: skill.source });
	}
	const unlinks = (owned?.skills ?? []).filter((path) => !links.includes(path) && isLink(join(home, path)));
	for (const path of unlinks) report.push(`skills: remove the link ${join(home, path)}`);

	const changed = writes.length + removals.length + linkWrites.length + unlinks.length > 0;
	if (!dryRun) {
		for (const [path, text] of writes) {
			mkdirSync(dirname(join(home, path)), { recursive: true });
			writeFileSync(join(home, path), text);
		}
		for (const path of removals) rmSync(join(home, path));
		for (const d of dirs) removeEmptyDirs(home, d);
		for (const path of unlinks) unlinkSync(join(home, path));
		// A parent folder kalfa's files were the last thing in goes too; one with the Operator's files stays.
		if (!planned) for (const path of [...dirs, ...unlinks]) removeIfEmpty(dirname(join(home, path)));
		for (const { target, source } of linkWrites) {
			if (isLink(target)) unlinkSync(target);
			mkdirSync(dirname(target), { recursive: true });
			symlinkSync(source, target);
		}
	}
	return { report, changed, owned: planned ? { dir, skills: links } : undefined };
}

/** A harness that can hold the Personal layer's Instruction files. */
export interface RulesHarness {
	name: string;
	layout: RuleLayout;
	capabilities: ReadonlySet<Capability>;
}

/** The Personal layer's Instruction files for one harness, from the pack as it is now; problems are the pack files left out. */
export function planUserRules(env: NodeJS.ProcessEnv, harness: Omit<RulesHarness, 'name'>): PlannedRules & { problems: string[] } {
	const layer = personalLayer(memoryHome(env));
	const { rules, problems } = scanPack(layer);
	return { ...planRuleFiles(layer, rules, harness.layout, harness.capabilities), problems };
}
