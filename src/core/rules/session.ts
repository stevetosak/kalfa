// The rules at session start (ADR 0003): no session loses a rule. Where kalfa
// install recorded the Personal layer's Instruction files, the session start
// writes them again from the Rule pack, as it does the instruction file, so
// the next session has the current rules. A layer whose files are not there
// for this harness (no install yet, a new worktree with no build, a repository
// with no kalfa.yaml, a harness with no rule layout) gets its rules in the
// session report instead, with a note that says which command writes them.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { RuleLayout } from '../../adapters/adapter.ts';
import type { Capability } from '../capabilities.ts';
import { readInstallState, writeInstallState } from '../install.ts';
import { memoryHome, personalLayer, projectLayer } from '../memory/home.ts';
import type { Project } from '../project.ts';
import { loadedRules, planRuleFiles, rulesReport, staleFiles } from './files.ts';
import { scanPack, SKILL_FILE } from './pack.ts';
import { applyUserRules, planUserRules } from './user-files.ts';

/** The rule layouts of the harness that raised the event. */
export interface RuleLayouts {
	user?: RuleLayout;
	project?: RuleLayout;
}

export interface RulesPart {
	context?: string;
	notice?: string;
	/** How many rules the report holds, for the Operator's summary line. */
	inReport: number;
}

/**
 * Writes the Personal layer's Instruction files again when `kalfa install`
 * recorded them for `harness`; `true` when they are current after it.
 */
export function refreshUserRules(env: NodeJS.ProcessEnv, harness: string, layout: RuleLayout | undefined, capabilities: ReadonlySet<Capability>): boolean {
	if (!layout || !capabilities.has('instruction-file') || !env.HOME) return false;
	const state = readInstallState(env);
	const owned = state.harnesses[harness]?.rules;
	if (!owned) return false;
	const { problems, ...planned } = planUserRules(env, { layout, capabilities });
	const result = applyUserRules(env.HOME, layout, planned, owned, false);
	if (result.owned && JSON.stringify(result.owned) !== JSON.stringify(owned)) {
		state.harnesses[harness] = { ...state.harnesses[harness]!, rules: result.owned };
		writeInstallState(env, state);
	}
	return !problems.length && result.owned?.skills.length === planned.skills.length;
}

function personalPart(env: NodeJS.ProcessEnv, harness: string, layout: RuleLayout | undefined, capabilities: ReadonlySet<Capability>): RulesPart {
	const layer = personalLayer(memoryHome(env));
	const { rules: pack, problems } = scanPack(layer);
	const notices = problems.map((p) => `kalfa: rules: left out: ${p}`);
	let current = false;
	try {
		current = refreshUserRules(env, harness, layout, capabilities);
	} catch (error) {
		notices.push(`kalfa: rules: the Personal layer's files were not written: ${(error as Error).message}`);
	}
	if (current || !pack.length) return { notice: notices.join('\n') || undefined, inReport: 0 };
	const rules = loadedRules(layer, pack, capabilities);
	notices.push("kalfa: the Personal layer's rules are in the session report; kalfa install writes them as files");
	return { context: rulesReport(rules, 'kalfa install writes them as files') || undefined, notice: notices.join('\n'), inReport: rules.always.length + rules.scoped.length };
}

function projectPart(project: Project, env: NodeJS.ProcessEnv, layout: RuleLayout | undefined, capabilities: ReadonlySet<Capability>): RulesPart {
	const layer = projectLayer(memoryHome(env), project);
	const { rules: pack, problems } = scanPack(layer);
	const notices = problems.map((p) => `kalfa: rules: left out: ${p}`);
	if (!pack.length) return { notice: notices.join('\n') || undefined, inReport: 0 };
	if (layout) {
		const planned = planRuleFiles(layer, pack, layout, capabilities);
		const stale = staleFiles(project.root, planned.files);
		const skills = planned.skills.every((skill) => existsSync(join(project.root, skill.target, SKILL_FILE)));
		if (!stale.missing.length && !stale.changed.length && skills) return { notice: notices.join('\n') || undefined, inReport: 0 };
	}
	const rules = loadedRules(layer, pack, capabilities);
	notices.push("kalfa: the project's rules are in the session report; kalfa build writes them as files here");
	return { context: rulesReport(rules, 'kalfa build writes them as files in this repository') || undefined, notice: notices.join('\n'), inReport: rules.always.length + rules.scoped.length };
}

/** The rules part of the session report: empty when every layer's rules load from their files. */
export function sessionRules(project: Project | undefined, env: NodeJS.ProcessEnv, harness: string, layouts: RuleLayouts, capabilities: ReadonlySet<Capability>): RulesPart {
	const parts = [personalPart(env, harness, layouts.user, capabilities), ...(project ? [projectPart(project, env, layouts.project, capabilities)] : [])];
	const context = parts.map((p) => p.context).filter(Boolean).join('\n\n');
	const notice = parts.map((p) => p.notice).filter(Boolean).join('\n');
	return { context: context || undefined, notice: notice || undefined, inReport: parts.reduce((n, p) => n + p.inReport, 0) };
}
