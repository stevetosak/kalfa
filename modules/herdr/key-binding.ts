// The key that starts the plugin's action. Herdr (0.9.3-0.9.5) lists no
// plugin action in a menu: an action runs only from a `plugin_action` key
// binding in Herdr's config.toml. Herdr has no command to add one, so install
// writes the binding as a block between two marker lines; the markers make the
// block kalfa's, and uninstall removes only that block. The new text is checked
// with `herdr config check` on a copy before the real file changes.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { MachineStep } from '../../src/core/machine-step.ts';
import { herdrOnPath } from './launcher.ts';
import { PLUGIN_ACTION, PLUGIN_ID } from './plugin.ts';

export const KEY = 'prefix+shift+a';

const BEGIN = '# >>> kalfa: the key of the kalfa plugin (kalfa install writes this block, kalfa uninstall removes it)';
const END = '# <<< kalfa';

const BLOCK = [
	BEGIN,
	'[[keys.command]]',
	`key = "${KEY}"`,
	'type = "plugin_action"',
	`command = "${PLUGIN_ID}.${PLUGIN_ACTION}"`,
	'description = "kalfa: new Task, open Task or Workspace"',
	END,
].join('\n');

/** Herdr's config.toml, found as Herdr finds it. */
export function herdrConfigPath(env: NodeJS.ProcessEnv): string {
	if (env.HERDR_CONFIG_PATH) return env.HERDR_CONFIG_PATH;
	const base = env.XDG_CONFIG_HOME || join(env.HOME ?? '', '.config');
	return join(base, 'herdr', 'config.toml');
}

/** The text without kalfa's block (and without the blank line before it). */
export function withoutKeyBlock(text: string): string {
	const start = text.indexOf(BEGIN);
	if (start < 0) return text;
	const end = text.indexOf(END, start);
	if (end < 0) return text;
	const before = text.slice(0, start).replace(/\n+$/, '');
	const after = text.slice(end + END.length).replace(/^\n+/, '');
	if (!before) return after;
	return after ? `${before}\n\n${after}` : `${before}\n`;
}

/** The text with kalfa's block at the end, in place of an old one. */
export function withKeyBlock(text: string): string {
	const rest = withoutKeyBlock(text).replace(/\n*$/, '');
	return rest ? `${rest}\n\n${BLOCK}\n` : `${BLOCK}\n`;
}

/** The Operator binds kalfa's key outside kalfa's block. */
export const keyTakenOutside = (text: string): boolean => new RegExp(`^\\s*key\\s*=\\s*"${KEY.replace(/\+/g, '\\+')}"`, 'm').test(withoutKeyBlock(text));

/** Throws with Herdr's diagnostics when the config text is not valid. */
export type ConfigCheck = (text: string) => void;

export const herdrConfigCheck: ConfigCheck = (text) => {
	const dir = mkdtempSync(join(tmpdir(), 'kalfa-herdr-config-'));
	try {
		const path = join(dir, 'config.toml');
		writeFileSync(path, text);
		execFileSync('herdr', ['config', 'check'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, HERDR_CONFIG_PATH: path } });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
};

const read = (path: string) => (existsSync(path) ? readFileSync(path, 'utf8') : '');

const RELOAD = `press prefix+shift+r in Herdr (or run herdr server reload-config) to load it now`;

export function keyBindingStep(check: ConfigCheck = herdrConfigCheck): MachineStep {
	const withHerdr = (env: NodeJS.ProcessEnv, run: () => string[]) => (herdrOnPath(env) ? run() : ['key: herdr is not on PATH; nothing to do']);
	return {
		install: ({ env, dryRun }) =>
			withHerdr(env, () => {
				const path = herdrConfigPath(env);
				const text = read(path);
				if (keyTakenOutside(text)) return [`key: ${KEY} is already bound in ${path}; left as it is (bind ${PLUGIN_ID}.${PLUGIN_ACTION} to a key of your own)`];
				const next = withKeyBlock(text);
				if (next === text) return [`key: ${KEY} runs ${PLUGIN_ID}.${PLUGIN_ACTION} (${path}); nothing to change`];
				check(next);
				if (!dryRun) {
					mkdirSync(dirname(path), { recursive: true });
					writeFileSync(path, next);
				}
				return [`key: ${KEY} runs ${PLUGIN_ID}.${PLUGIN_ACTION}, written to ${path}; ${RELOAD}`];
			}),
		uninstall: ({ env, dryRun }) =>
			withHerdr(env, () => {
				const path = herdrConfigPath(env);
				const text = read(path);
				const next = withoutKeyBlock(text);
				if (next === text) return ['key: no kalfa block in Herdr\'s config; nothing to change'];
				if (!dryRun) writeFileSync(path, next);
				return [`key: removed kalfa's block from ${path}`];
			}),
	};
}
