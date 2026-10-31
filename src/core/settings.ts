// The machine settings: the operator's own choices for this machine, never
// committed. Sections add their fields as they need them.
import { join } from 'node:path';
import { z } from 'zod';
import { machineConfigDir } from './machine-paths.ts';
import { moduleList, moduleName } from './project.ts';
import { readVersioned, type VersionedFormat } from './versioned-file.ts';

/** A Memory layer's budget for Standing memory: rules by count, index lines by bytes. */
const layerBudget = z.strictObject({
	rules: z.int().positive(),
	'index-bytes': z.int().positive(),
});

const memorySettings = z.strictObject({
	personal: layerBudget.partial().optional(),
	project: layerBudget.partial().optional(),
	/** The longest rule (summary and body), in characters: a rule is short and exact. */
	'rule-chars': z.int().positive().optional(),
});

const settingsSchema = z.strictObject({
	schema: z.literal(1),
	/**
	 * The Operator's own Modules: they run in every session on this machine,
	 * in every repository and outside one. A repository's `kalfa.yaml` adds
	 * its Modules on top; personal ones (the meter) belong here, not there.
	 */
	modules: moduleList,
	/** The Standing memory budgets; each value left out takes its default. */
	memory: memorySettings.optional(),
	/**
	 * Per Module, the Operator's own settings on this machine. Each Module
	 * checks its part; a key in `kalfa.yaml` overrides the same key here.
	 */
	settings: z.record(moduleName, z.unknown()).optional(),
	/**
	 * More Module folders, after the package's own: a Module that is not
	 * generic lives in its own repository. A Module name in two folders is refused.
	 */
	'module-dirs': z
		.array(z.string().refine((dir) => dir.startsWith('/') || dir.startsWith('~/'), 'a Module folder is an absolute path or starts with ~/'))
		.optional(),
});

export type Settings = z.infer<typeof settingsSchema>;

export const settingsFormat: VersionedFormat<Settings> = {
	name: 'machine settings',
	current: 1,
	schema: settingsSchema,
};

export const DEFAULT_SETTINGS: Settings = { schema: 1, modules: [] };

export function settingsPath(env: NodeJS.ProcessEnv = process.env): string {
	return join(machineConfigDir(env), 'config.yaml');
}

export function loadSettings(env: NodeJS.ProcessEnv = process.env): Settings {
	return readVersioned(settingsPath(env), settingsFormat) ?? DEFAULT_SETTINGS;
}

export type LayerBudget = z.infer<typeof layerBudget>;

export interface MemoryBudgets {
	personal: LayerBudget;
	project: LayerBudget;
	ruleChars: number;
}

/**
 * First values only: Plan step 5 sets them from the measured size of the
 * sorted memory. The rule count limits how many instructions load; the
 * index bytes limit what the index lines cost in context.
 */
export const DEFAULT_MEMORY_BUDGETS: MemoryBudgets = {
	personal: { rules: 25, 'index-bytes': 4096 },
	project: { rules: 15, 'index-bytes': 4096 },
	ruleChars: 600,
};

export function memoryBudgets(settings: Settings): MemoryBudgets {
	const memory = settings.memory ?? {};
	return {
		personal: { ...DEFAULT_MEMORY_BUDGETS.personal, ...memory.personal },
		project: { ...DEFAULT_MEMORY_BUDGETS.project, ...memory.project },
		ruleChars: memory['rule-chars'] ?? DEFAULT_MEMORY_BUDGETS.ruleChars,
	};
}
