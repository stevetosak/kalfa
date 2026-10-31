// The machine settings: the operator's own choices for this machine, never
// committed. Sections add their fields as they need them.
import { join } from 'node:path';
import { z } from 'zod';
import { machineConfigDir } from './machine-paths.ts';
import { moduleList } from './project.ts';
import { readVersioned, type VersionedFormat } from './versioned-file.ts';

const settingsSchema = z.strictObject({
	schema: z.literal(1),
	/**
	 * The Operator's own Modules: they run in every session on this machine,
	 * in every repository and outside one. A repository's `kalfa.yaml` adds
	 * its Modules on top; personal ones (the meter) belong here, not there.
	 */
	modules: moduleList,
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
