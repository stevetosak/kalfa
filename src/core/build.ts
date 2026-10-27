// `kalfa build`: writes the enabled Modules' files into a repository in the
// form each harness reads, and nothing else. `.kalfa/build.yaml` records every
// file and approval entry kalfa wrote, with a hash, so a later build removes
// what a Module no longer produces and never overwrites or removes a file
// kalfa did not write or the Operator changed by hand. Every target must be
// ignored by git: the repositories are public, and generated files are not
// committed.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { z } from 'zod';
import type { ProjectFiles } from '../adapters/adapter.ts';
import { KalfaError } from './errors.ts';
import { APPROVAL_KINDS, type Approvals, type ModuleSource } from './module-source.ts';
import { PRIVATE_DIR, privateDir } from './private-dir.ts';
import { readVersioned, type VersionedFormat } from './versioned-file.ts';

const entries = z.array(z.string()).default([]);

const harnessState = z.strictObject({
	/** Path → sha256 of what kalfa wrote. */
	files: z.record(z.string(), z.string()).default({}),
	/** The approval entries kalfa added; the Operator's own entries are never listed. */
	approvals: z.strictObject({ allow: entries, ask: entries, deny: entries }).default({ allow: [], ask: [], deny: [] }),
});

export type HarnessState = z.infer<typeof harnessState>;

const buildStateSchema = z.strictObject({
	schema: z.literal(1),
	harnesses: z.record(z.string(), harnessState).default({}),
});

export type BuildState = z.infer<typeof buildStateSchema>;

const buildStateFormat: VersionedFormat<BuildState> = { name: 'build.yaml', current: 1, schema: buildStateSchema };

export const buildStatePath = (root: string) => join(root, PRIVATE_DIR, 'build.yaml');

export const readBuildState = (root: string): BuildState => readVersioned(buildStatePath(root), buildStateFormat) ?? { schema: 1, harnesses: {} };

export function writeBuildState(root: string, state: BuildState): void {
	privateDir(root);
	writeFileSync(buildStatePath(root), `${JSON.stringify(state, null, 2)}\n`);
}

/** A skill ready to install: its name and its files by relative path. */
export interface SkillBundle {
	name: string;
	files: Map<string, Buffer>;
}

/** Every file under `dir`, by path relative to it. */
export function readTree(dir: string): Map<string, Buffer> {
	const files = new Map<string, Buffer>();
	for (const entry of (readdirSync(dir, { recursive: true }) as string[]).sort()) {
		const path = join(dir, entry);
		if (statSync(path).isFile()) files.set(entry.split('\\').join('/'), readFileSync(path));
	}
	return files;
}

export interface PlannedHarness {
	files: Map<string, Buffer>;
	/** In the harness's form. */
	approvals: Approvals;
}

/** What the Modules produce for one harness. `skills` gives each Module's skill bundles. */
export function planHarness(sources: ModuleSource[], project: ProjectFiles, skills: (source: ModuleSource) => SkillBundle[]): PlannedHarness {
	const files = new Map<string, Buffer>();
	const owner = new Map<string, string>();
	const add = (path: string, content: Buffer, module: string) => {
		const other = owner.get(path);
		if (other) throw new KalfaError(`the Modules ${other} and ${module} both write ${path}`);
		owner.set(path, module);
		files.set(path, content);
	};
	const approvals: Approvals = { allow: [], ask: [], deny: [] };
	for (const source of sources) {
		for (const skill of skills(source)) {
			for (const [path, content] of skill.files) add(`${project.skillDir(skill.name)}/${path}`, content, source.name);
		}
		for (const rule of source.rules) {
			const { path, text } = project.rule(source.name, rule);
			add(path, Buffer.from(text), source.name);
		}
		for (const kind of APPROVAL_KINDS) {
			for (const pattern of source.manifest.commands[kind]) {
				const entry = project.approvals.entry(pattern);
				if (!approvals[kind].includes(entry)) approvals[kind].push(entry);
			}
		}
	}
	return { files, approvals };
}

const sha256 = (content: Buffer) => createHash('sha256').update(content).digest('hex');

function hashOf(path: string): string | undefined {
	return existsSync(path) ? sha256(readFileSync(path)) : undefined;
}

/** The paths git does not ignore (a tracked file counts as not ignored). */
export function notIgnored(root: string, paths: string[]): string[] {
	if (!paths.length) return [];
	const check = spawnSync('git', ['check-ignore', '--stdin', '-z'], { cwd: root, input: paths.join('\0'), encoding: 'utf8' });
	if (check.status !== 0 && check.status !== 1) throw new KalfaError(`${root}: git check-ignore failed: ${check.stderr.trim() || check.status}`);
	const ignored = new Set(check.stdout.split('\0').filter(Boolean));
	return paths.filter((path) => !ignored.has(path));
}

export interface BuildOptions {
	dryRun?: boolean;
	/** Overwrite files kalfa wrote that were changed by hand since. */
	force?: boolean;
}

export interface HarnessResult {
	/** One line per change, for the Operator. */
	report: string[];
	state: HarnessState;
}

function readApprovalFile(root: string, path: string, problems: string[]): Record<string, unknown> {
	const file = join(root, path);
	if (!existsSync(file)) return {};
	try {
		const data: unknown = JSON.parse(readFileSync(file, 'utf8'));
		if (typeof data === 'object' && data !== null && !Array.isArray(data)) return data as Record<string, unknown>;
	} catch {
		// reported below
	}
	problems.push(`${path}: not a JSON object; kalfa cannot merge its approvals`);
	return {};
}

/**
 * Brings one harness's files in `root` to `planned`. Checks everything first
 * and writes nothing when a check fails.
 */
export function applyHarness(root: string, project: ProjectFiles, planned: PlannedHarness, previous: HarnessState | undefined, options: BuildOptions = {}): HarnessResult {
	const problems: string[] = [];
	const report: string[] = [];
	const owned = previous?.files ?? {};
	const writes: string[] = [];
	const removals: string[] = [];
	let unchanged = 0;

	for (const [path, content] of planned.files) {
		const current = hashOf(join(root, path));
		if (current === undefined) writes.push(path);
		else if (current === sha256(content)) unchanged++;
		else if (owned[path] === undefined) problems.push(`${path}: exists and kalfa did not write it; move it away or remove it`);
		else if (owned[path] !== current && !options.force) problems.push(`${path}: changed by hand since the last build; --force overwrites it`);
		else writes.push(path);
	}
	for (const [path, hash] of Object.entries(owned)) {
		if (planned.files.has(path)) continue;
		const current = hashOf(join(root, path));
		if (current === hash) removals.push(path);
		else if (current !== undefined) report.push(`keep ${path} (no Module writes it any more, but it was changed by hand)`);
	}

	// Approvals: add what the Modules want, remove only what kalfa added before.
	const approvalPath = project.approvals.path;
	const before = readApprovalFile(root, approvalPath, problems);
	let after = before;
	const ownedApprovals: Approvals = { allow: [], ask: [], deny: [] };
	for (const kind of APPROVAL_KINDS) {
		const present = project.approvals.read(before, kind);
		const want = planned.approvals[kind];
		const added = previous?.approvals[kind] ?? [];
		const kept = present.filter((entry) => want.includes(entry) || !added.includes(entry));
		const fresh = want.filter((entry) => !present.includes(entry));
		ownedApprovals[kind] = [...added.filter((entry) => want.includes(entry) && present.includes(entry)), ...fresh];
		for (const entry of present.filter((e) => !kept.includes(e))) report.push(`approvals: remove ${kind} ${entry}`);
		for (const entry of fresh) report.push(`approvals: add ${kind} ${entry}`);
		if (kept.length !== present.length || fresh.length) after = project.approvals.write(after, kind, [...kept, ...fresh]);
	}
	const approvalsChange = after !== before;

	const targets = [...planned.files.keys(), ...(approvalsChange ? [approvalPath] : [])];
	for (const path of notIgnored(root, targets)) problems.push(`${path}: git does not ignore it; kalfa writes only ignored files`);
	if (problems.length) throw new KalfaError(`kalfa build changed nothing:\n${problems.map((p) => `- ${p}`).join('\n')}`);

	for (const path of writes) report.push(`write ${path}`);
	for (const path of removals) report.push(`remove ${path}`);
	if (unchanged) report.push(`${unchanged} file(s) unchanged`);

	if (!options.dryRun) {
		for (const path of writes) {
			mkdirSync(dirname(join(root, path)), { recursive: true });
			writeFileSync(join(root, path), planned.files.get(path)!);
		}
		for (const path of removals) {
			rmSync(join(root, path));
			removeEmptyParents(root, dirname(join(root, path)));
		}
		if (approvalsChange) {
			mkdirSync(dirname(join(root, approvalPath)), { recursive: true });
			writeFileSync(join(root, approvalPath), `${JSON.stringify(after, null, 2)}\n`);
		}
	}

	const files = Object.fromEntries([...planned.files].map(([path, content]) => [path, sha256(content)]));
	return { report, state: { files, approvals: ownedApprovals } };
}

function removeEmptyParents(root: string, dir: string): void {
	for (let at = dir; relative(root, at) && !relative(root, at).startsWith('..'); at = dirname(at)) {
		if (readdirSync(at).length) return;
		rmdirSync(at);
	}
}
