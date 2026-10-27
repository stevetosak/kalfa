// Third-party skills: fetched at the commit a Module pins, kept in a machine
// cache, and installed with the Module's Overlay appended. APM cannot keep an
// Overlay next to the upstream skill (see the APM spike Log), so kalfa composes
// the skill itself. The cache never changes a commit's content; the build
// state records each skill's hash, so a cache changed on disk is refused.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { readTree, type SkillBundle } from './build.ts';
import { KalfaError } from './errors.ts';
import type { ModuleSource, ThirdPartySkill } from './module-source.ts';

export function cacheRoot(env: NodeJS.ProcessEnv): string {
	const base = env.XDG_CACHE_HOME || (env.HOME ? join(env.HOME, '.cache') : undefined);
	if (!base) throw new KalfaError('neither XDG_CACHE_HOME nor HOME is set; kalfa has no cache folder');
	return join(base, 'kalfa');
}

function git(args: string[], cwd: string): string {
	const out = spawnSync('git', args, { cwd, encoding: 'utf8' });
	if (out.status !== 0) throw new KalfaError(`git ${args.join(' ')}: ${out.stderr.trim() || `status ${out.status}`}`);
	return out.stdout.trim();
}

/** The checkout of `source` at `commit` in the cache; fetched once. */
export function checkoutAt(cache: string, source: string, commit: string): string {
	const dir = join(cache, 'sources', createHash('sha256').update(source).digest('hex').slice(0, 16), commit);
	if (existsSync(dir)) return dir;
	const work = `${dir}.partial-${process.pid}`;
	rmSync(work, { recursive: true, force: true });
	mkdirSync(work, { recursive: true });
	try {
		git(['init', '-q'], work);
		git(['fetch', '-q', '--depth', '1', '--', source, commit], work);
		const fetched = git(['rev-parse', 'FETCH_HEAD'], work);
		if (fetched !== commit) throw new KalfaError(`${source}: fetched ${fetched}, not the pinned ${commit}`);
		git(['-c', 'advice.detachedHead=false', 'checkout', '-q', 'FETCH_HEAD'], work);
		rmSync(join(work, '.git'), { recursive: true, force: true });
		renameSync(work, dir);
	} catch (error) {
		rmSync(work, { recursive: true, force: true });
		throw error;
	}
	return dir;
}

/** One hash over a skill's paths and contents. */
export function treeHash(files: Map<string, Buffer>): string {
	const hash = createHash('sha256');
	for (const [path, content] of [...files].sort(([a], [b]) => (a < b ? -1 : 1))) {
		hash.update(`${path}\0${createHash('sha256').update(content).digest('hex')}\n`);
	}
	return hash.digest('hex');
}

export interface FetchedSkill {
	bundle: SkillBundle;
	/** The upstream skill's hash, before the Overlay. */
	sha256: string;
}

/** The pinned skill with the Module's Overlay appended to its SKILL.md. */
export function composeThirdParty(source: ModuleSource, pin: ThirdPartySkill, cache: string): FetchedSkill {
	const dir = join(checkoutAt(cache, pin.source, pin.commit), pin.path);
	if (!existsSync(join(dir, 'SKILL.md'))) throw new KalfaError(`${pin.source} at ${pin.commit.slice(0, 12)}: no SKILL.md in ${pin.path}`);
	const files = readTree(dir);
	const sha256 = treeHash(files);
	if (pin.overlay) {
		const upstream = files.get('SKILL.md')!.toString('utf8');
		const overlay = readFileSync(join(source.dir, pin.overlay), 'utf8');
		const marker = `<!-- kalfa Overlay from the Module '${source.name}' -->`;
		files.set('SKILL.md', Buffer.from(`${upstream.replace(/\n*$/, '\n')}\n${marker}\n\n${overlay}`));
	}
	return { bundle: { name: pin.name, files }, sha256 };
}
