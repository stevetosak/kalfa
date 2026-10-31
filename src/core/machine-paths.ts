// The machine's own kalfa folders, outside every repository (XDG layout).
import { homedir } from 'node:os';
import { join } from 'node:path';

/** `$XDG_CONFIG_HOME/kalfa`, else `~/.config/kalfa`: the Operator's choices for this machine. */
export function machineConfigDir(env: NodeJS.ProcessEnv = process.env): string {
	return join(env.XDG_CONFIG_HOME || join(env.HOME || homedir(), '.config'), 'kalfa');
}

/** `$XDG_CACHE_HOME/kalfa`, else `~/.cache/kalfa`: state kalfa can write again at any time. */
export function machineCacheDir(env: NodeJS.ProcessEnv = process.env): string {
	return join(env.XDG_CACHE_HOME || join(env.HOME || homedir(), '.cache'), 'kalfa');
}

/** `$XDG_DATA_HOME/kalfa`, else `~/.local/share/kalfa`: the Operator's data that kalfa keeps (the Memory home). */
export function machineDataDir(env: NodeJS.ProcessEnv = process.env): string {
	return join(env.XDG_DATA_HOME || join(env.HOME || homedir(), '.local', 'share'), 'kalfa');
}
