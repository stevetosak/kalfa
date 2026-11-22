// `kalfa rule`: the only way the agent writes a rule (ADR 0003). A rule lives
// in its layer's Rule pack in the Memory home, apart from the Memory records;
// each write is checked (length, path patterns, layer), committed in the
// Memory home, and written again as the Instruction files: the Personal
// layer's in the harnesses' user folders, a project's through `kalfa build` in
// this repository. `migrate` moves the rule records of every layer into their
// packs once, with their text unchanged.
import { isDeepStrictEqual } from 'node:util';
import type { Adapter } from '../../adapters/adapter.ts';
import { KalfaError } from '../../core/errors.ts';
import { allLayers, type Layer, type LayerName, memoryHome, projectKey, readLayer, recordPath, sessionLayers } from '../../core/memory/home.ts';
import { refreshInstructions } from '../../core/memory/instructions.ts';
import { checkHeader, type MemoryRecord, renderMemoryRecord, ruleText, slugOf } from '../../core/memory/record.ts';
import type { ModuleDirs } from '../../core/module-dirs.ts';
import { loadProject } from '../../core/project.ts';
import { checkPackRule, commitPack, type PackRule, packPath, readPack, type RuleForm, type RuleLimits } from '../../core/rules/pack.ts';
import { refreshUserRules } from '../../core/rules/session.ts';
import { loadSettings, memoryBudgets } from '../../core/settings.ts';
import { type Command, parseCommandArgs, UsageError } from '../command.ts';
import type { Io } from '../io.ts';
import { buildProject } from './build.ts';
import { layerFor, layerName } from './memory.ts';

const today = () => new Date().toLocaleDateString('sv-SE');

const limits = (io: Io): RuleLimits => ({ ruleChars: memoryBudgets(loadSettings(io.env)).ruleChars });

const formOptions = {
	path: { type: 'string', multiple: true },
	skill: { type: 'string' },
} as const;

/** The form the options ask for; `undefined` when they name none. */
function formOf(values: { path?: string[]; skill?: string; always?: boolean }): { form: RuleForm; paths?: string[]; description?: string } | undefined {
	const named = [values.path?.length ? '--path' : '', values.skill !== undefined ? '--skill' : '', values.always ? '--always' : ''].filter(Boolean);
	if (named.length > 1) throw new UsageError(`a rule has one form: give only one of ${named.join(', ')}`);
	if (values.path?.length) return { form: 'path', paths: values.path };
	if (values.skill !== undefined) return { form: 'skill', description: values.skill };
	if (values.always) return { form: 'always' };
	return undefined;
}

const firstLine = (text: string) => text.split('\n')[0]!;
const restOf = (text: string) => text.split('\n').slice(1).join('\n').trim();
const compose = (line: string, rest: string) => (rest ? `${line.trim()}\n${rest.trim()}` : line.trim());

/** The rule `id` in the layers this directory sees, or in the one named. */
function findRule(io: Io, id: string, name: LayerName | undefined): { layer: Layer; rule: PackRule; pack: PackRule[] } {
	const layers = name ? [layerFor(io, name)] : sessionLayers(memoryHome(io.env), loadProject(io.cwd));
	const found = layers.flatMap((layer) => {
		const pack = readPack(layer);
		const rule = pack.find((r) => r.id === id);
		return rule ? [{ layer, rule, pack }] : [];
	});
	if (!found.length) throw new KalfaError(`no rule '${id}'${name ? ` in the ${name} layer` : ''} (kalfa rule list)`);
	if (found.length > 1) throw new KalfaError(`'${id}' is in more than one layer; name one with --layer personal|project`);
	return found[0]!;
}

function uniqueId(pack: readonly PackRule[], wanted: string): string {
	const taken = new Set(pack.map((r) => r.id));
	if (!taken.has(wanted)) return wanted;
	for (let n = 2; ; n++) if (!taken.has(`${wanted}-${n}`)) return `${wanted}-${n}`;
}

/**
 * Writes the Instruction files of the layers that changed: the Personal
 * layer's for each harness `kalfa install` recorded them for, this
 * repository's by `kalfa build`; another repository's at its own build. A
 * failure here leaves the rule saved and says what to run.
 */
function writeFiles(io: Io, layers: readonly Layer[], adapters: ReadonlyMap<string, Adapter>, moduleDirs: ModuleDirs): void {
	if (layers.some((layer) => layer.name === 'personal')) {
		// A migrate closes rule records, which leave the Personal layer's instruction file.
		try {
			refreshInstructions(io.env, loadSettings(io.env));
		} catch (error) {
			io.err(`kalfa rule: the instruction file was not written again: ${(error as Error).message}`);
		}
		const written = [...adapters.values()].filter((adapter) => {
			try {
				return refreshUserRules(io.env, adapter.name, adapter.user?.rules, adapter.capabilities);
			} catch (error) {
				io.err(`kalfa rule: ${adapter.name}: the Personal layer's files were not written: ${(error as Error).message}`);
				return false;
			}
		});
		io.out(written.length ? `Personal rules written for ${written.map((a) => a.name).join(', ')}` : "Personal rules: no harness has kalfa install's rule files yet; kalfa install writes them, and until then they load from the session report");
	}
	const project = loadProject(io.cwd);
	if (!project || !layers.some((layer) => layer.name === 'project' && layer.label === projectKey(project.root))) return;
	if (!project.file) {
		io.out("Project rules: this repository has no kalfa.yaml, so they load from the session report (kalfa init, then kalfa build, writes them as files)");
		return;
	}
	try {
		const run = buildProject(project, adapters, moduleDirs(io.env), io.env, { offline: true });
		io.out('Project rules: kalfa build');
		for (const line of run.report) io.out(`  ${line}`);
	} catch (error) {
		if (!(error instanceof KalfaError)) throw error;
		io.err(`kalfa rule: the rule is saved, but kalfa build did not run: ${error.message}`);
	}
}

const describe = (rule: PackRule) => (rule.form === 'path' ? `path ${rule.paths!.join(', ')}` : rule.form === 'skill' ? `skill: ${rule.description}` : 'always');

type Subcommand = (args: string[], io: Io) => Promise<Layer[]>;

const subcommands: Record<string, Subcommand> = {
	async add(args, io) {
		const { values } = parseCommandArgs(args, { layer: { type: 'string' }, summary: { type: 'string' }, id: { type: 'string' }, ...formOptions });
		const name = layerName(values.layer);
		if (!name) throw new UsageError('give --layer personal or --layer project');
		if (!values.summary?.trim()) throw new UsageError('give --summary "<the rule, one line>"');
		if (values.summary.includes('\n')) throw new UsageError('the summary is the rule in one line; the reasons go on stdin');
		const layer = layerFor(io, name);
		const pack = readPack(layer);
		if (values.id && pack.some((r) => r.id === values.id)) throw new KalfaError(`'${values.id}' already exists in the ${layer.label} layer (kalfa rule change)`);
		const form = formOf(values) ?? { form: 'always' };
		const rule = checkPackRule({ id: values.id ?? uniqueId(pack, slugOf(values.summary)), ...form, text: compose(values.summary, await io.stdin()) }, limits(io));
		commitPack(memoryHome(io.env), [{ layer, write: [rule] }], `add rule ${rule.id} (${layer.label}, ${rule.form})`);
		io.out(`Added the rule ${rule.id} (${describe(rule)}) to the ${layer.label} layer: ${packPath(layer, rule.id, rule.form)}`);
		return [layer];
	},

	async change(args, io) {
		const { values, positionals } = parseCommandArgs(args, { layer: { type: 'string' }, summary: { type: 'string' }, always: { type: 'boolean' }, ...formOptions }, true);
		const [id, ...extra] = positionals;
		if (!id || extra.length) throw new UsageError('give the id of one rule');
		if (values.summary?.includes('\n')) throw new UsageError('the summary is the rule in one line; the reasons go on stdin');
		const { layer, rule: old } = findRule(io, id, layerName(values.layer));
		const form = formOf(values) ?? { form: old.form, paths: old.paths, description: old.description };
		const rest = (await io.stdin()).trim();
		const text = compose(values.summary ?? firstLine(old.text), rest || restOf(old.text));
		const rule = checkPackRule({ id, ...form, text }, limits(io));
		if (isDeepStrictEqual(rule, old)) throw new KalfaError(`nothing to change in '${id}': give --summary, a form (--path, --skill, --always) or new reasons on stdin`);
		commitPack(memoryHome(io.env), [{ layer, write: [rule], remove: rule.form === old.form ? [] : [old] }], `change rule ${id} (${layer.label}, ${rule.form})`);
		io.out(`Changed the rule ${id} (${describe(rule)}) in the ${layer.label} layer`);
		return [layer];
	},

	async remove(args, io) {
		const { values, positionals } = parseCommandArgs(args, { layer: { type: 'string' } }, true);
		const [id, ...reasonWords] = positionals;
		const reason = reasonWords.join(' ').replace(/\s+/g, ' ').trim();
		if (!id || !reason) throw new UsageError('give the id and the reason: kalfa rule remove <id> "<why it no longer holds>"');
		const { layer, rule } = findRule(io, id, layerName(values.layer));
		commitPack(memoryHome(io.env), [{ layer, remove: [rule] }], `remove rule ${id} (${layer.label}): ${reason}`);
		io.out(`Removed the rule ${id} from the ${layer.label} layer; the Memory home's history keeps it`);
		return [layer];
	},

	async list(args, io) {
		const { values } = parseCommandArgs(args, { layer: { type: 'string' } });
		const name = layerName(values.layer);
		const layers = name ? [layerFor(io, name)] : sessionLayers(memoryHome(io.env), loadProject(io.cwd));
		let shown = 0;
		for (const layer of layers) {
			const pack = readPack(layer);
			if (!pack.length) continue;
			io.out(`${layer.label}:`);
			for (const rule of pack) io.out(`  ${rule.id}  ${describe(rule)}  ${firstLine(rule.text)}`);
			shown += pack.length;
		}
		if (!shown) io.out('no rules here');
		return [];
	},

	/**
	 * Every active rule record of every layer goes into its layer's pack with
	 * its text unchanged and loading always; the record is closed with a
	 * pointer to its file. One commit; nothing is written when a rule id is
	 * already in a pack.
	 */
	async migrate(args, io) {
		const { values } = parseCommandArgs(args, { 'dry-run': { type: 'boolean' } });
		const home = memoryHome(io.env);
		const date = today();
		const moves = allLayers(home).flatMap((layer) => {
			const records = readLayer(layer).filter((r) => r.header.type === 'rule' && r.header.status === 'active');
			return records.length ? [{ layer, records, pack: readPack(layer) }] : [];
		});
		const clashes = moves.flatMap(({ layer, records, pack }) => records.filter((r) => pack.some((rule) => rule.id === r.id)).map((r) => `${layer.label}: ${r.id}`));
		if (clashes.length) throw new KalfaError(`these rules are already in their Rule pack, so nothing was moved: ${clashes.join(', ')}`);
		if (!moves.length) {
			io.out('no active rule records; nothing to move');
			return [];
		}
		const records: Array<{ path: string; text: string }> = [];
		const changes = moves.map(({ layer, records: rules }) => {
			const write = rules.map((record): PackRule => ({ id: record.id, form: 'always', text: ruleText(record) }));
			for (const record of rules) {
				const pointer = `Moved to the Rule pack on ${date}: ${packPath(layer, record.id, 'always')}.`;
				const closed: MemoryRecord = { ...record, header: checkHeader({ ...record.header, status: 'closed' }), body: record.body ? `${record.body}\n\n${pointer}` : pointer };
				records.push({ path: recordPath(layer, record.id), text: renderMemoryRecord(closed) });
			}
			io.out(`${layer.label}: ${write.length} rule record(s) → ${packPath(layer, '<id>', 'always')}`);
			return { layer, write };
		});
		const total = changes.reduce((n, c) => n + c.write.length, 0);
		if (values['dry-run']) {
			io.out(`dry run: ${total} rule(s) would move; nothing was written`);
			return [];
		}
		commitPack(home, changes, `migrate ${total} rule record(s) to the Rule packs`, { write: records });
		io.out(`Moved ${total} rule(s); each record is closed with a pointer to its file`);
		const projects = changes.filter((c) => c.layer.name === 'project').map((c) => c.layer.label);
		if (projects.length) io.out(`Run kalfa build in each of these repositories to write their rules as files (until then they load from the session report): ${projects.join(', ')}`);
		return changes.map((c) => c.layer);
	},
};

const USAGE = [
	'kalfa rule add --layer personal|project --summary "<the rule, one line>" [--path <glob>]… [--skill "<the work it applies to>"] [--id <id>]',
	'         (reasons, or a skill\'s procedure, on stdin; give </dev/null for none)',
	'       kalfa rule change <id> [--layer …] [--summary "<…>"] [--path <glob>]… [--always] [--skill "<…>"]   (new reasons on stdin replace the old; </dev/null keeps them)',
	'       kalfa rule remove <id> "<why it no longer holds>" [--layer …]',
	'       kalfa rule list [--layer personal|project]',
	'       kalfa rule migrate [--dry-run]   (once: every active rule record of every layer moves into its Rule pack)',
].join('\n');

export function ruleCommand(adapters: ReadonlyMap<string, Adapter>, moduleDirs: ModuleDirs): Command {
	return {
		summary: "Add, change, remove or list the rules of a layer's Rule pack, and write them as the harnesses' Instruction files",
		usage: USAGE,
		async run(args, io) {
			const [sub, ...rest] = args;
			const run = sub && Object.hasOwn(subcommands, sub) ? subcommands[sub] : undefined;
			if (!run) throw new UsageError(sub ? `unknown subcommand '${sub}'` : 'give a subcommand');
			const changed = await run(rest, io);
			if (changed.length) writeFiles(io, changed, adapters, moduleDirs);
			return 0;
		},
	};
}
