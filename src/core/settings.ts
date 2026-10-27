// The machine settings: the operator's own choices for this machine, never
// committed. Sections add their fields as they need them.
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { readVersioned, type VersionedFormat } from './versioned-file.ts';

const settingsSchema = z.strictObject({
	schema: z.literal(1),
});

export type Settings = z.infer<typeof settingsSchema>;

export const settingsFormat: VersionedFormat<Settings> = {
	name: 'machine settings',
	current: 1,
	schema: settingsSchema,
};

export const DEFAULT_SETTINGS: Settings = { schema: 1 };

export function settingsPath(env: NodeJS.ProcessEnv = process.env): string {
	const config = env.XDG_CONFIG_HOME || join(env.HOME || homedir(), '.config');
	return join(config, 'kalfa', 'config.yaml');
}

export function loadSettings(env: NodeJS.ProcessEnv = process.env): Settings {
	return readVersioned(settingsPath(env), settingsFormat) ?? DEFAULT_SETTINGS;
}
