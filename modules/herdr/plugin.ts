// The herdr Module's Herdr plugin, in herdr-plugin/. Herdr lists its actions
// in the pane menu and runs them with no terminal, so an action only opens one
// of the plugin's popup panes (`kalfa space popup <pane>`), in the folder of
// the Workspace it was run from; the pane has a terminal and runs the form
// (`kalfa space new`). The manifest names kalfa commands only, so the logic
// stays here, tested. The commands need `kalfa` on Herdr's PATH.
import { join } from 'node:path';
import { KalfaError } from '../../src/core/errors.ts';
import type { MachineStep } from '../../src/core/machine-step.ts';
import { type HerdrExec, herdrCli, herdrOnPath } from './launcher.ts';
import { startFolder } from './space-form.ts';

/** The plugin id in herdr-plugin/herdr-plugin.toml. */
export const PLUGIN_ID = 'kalfa';

/** The popup panes of the manifest, by id. */
export const PLUGIN_PANES = ['new-task', 'open-space'] as const;
export type PluginPane = (typeof PLUGIN_PANES)[number];

export const isPluginPane = (pane: string): pane is PluginPane => (PLUGIN_PANES as readonly string[]).includes(pane);

/** Opens the plugin's popup pane in the folder of the Workspace the action was run from, and says so. */
export function openPopup(exec: HerdrExec, env: NodeJS.ProcessEnv, cwd: string, pane: string): string {
	if (!isPluginPane(pane)) throw new KalfaError(`no plugin pane '${pane}' (known: ${PLUGIN_PANES.join(', ')})`);
	const folder = startFolder(env, cwd);
	exec(['plugin', 'pane', 'open', '--plugin', env.HERDR_PLUGIN_ID || PLUGIN_ID, '--entrypoint', pane, '--placement', 'popup', '--cwd', folder, '--focus']);
	return `Opened the ${pane} popup in ${folder}.`;
}

/** The plugin's folder in the herdr Module's folder. */
export const pluginRoot = (moduleDir: string) => join(moduleDir, 'herdr-plugin');

interface LinkedPlugin {
	plugin_root: string;
	enabled: boolean;
	source: { kind: string };
}

/** The plugin Herdr has under kalfa's id, if any. */
function linkedPlugin(exec: HerdrExec): LinkedPlugin | undefined {
	const { result } = JSON.parse(exec(['plugin', 'list', '--plugin', PLUGIN_ID, '--json'])) as { result: { plugins?: LinkedPlugin[] } };
	return result.plugins?.[0];
}

/**
 * The herdr Module's part of `kalfa install`: Herdr links the plugin from the
 * package, so a new kalfa brings its new manifest at once. A link from another
 * folder (the package moved) is linked again; Herdr replaces it. A plugin with
 * kalfa's id that Herdr installed from elsewhere is the Operator's and stays.
 */
export function herdrPluginStep(exec: HerdrExec = herdrCli): MachineStep {
	const withHerdr = (env: NodeJS.ProcessEnv, run: () => string[]) => (herdrOnPath(env) ? run() : ['plugin: herdr is not on PATH; nothing to do']);
	return {
		install: ({ env, moduleDir, dryRun }) =>
			withHerdr(env, () => {
				const root = pluginRoot(moduleDir);
				const linked = linkedPlugin(exec);
				if (linked && linked.source.kind !== 'local') return [`plugin: '${PLUGIN_ID}' is installed from ${linked.source.kind}, not linked by kalfa; left as it is`];
				if (linked?.plugin_root === root) return [`plugin: linked from ${root}${linked.enabled ? '' : ' (disabled in Herdr)'}; nothing to change`];
				if (!dryRun) exec(['plugin', 'link', root]);
				const was = linked ? ` (was ${linked.plugin_root})` : '';
				return [`plugin: link ${root}${was}; Herdr's pane menu shows the kalfa actions`];
			}),
		uninstall: ({ env, dryRun }) =>
			withHerdr(env, () => {
				const linked = linkedPlugin(exec);
				if (!linked) return ['plugin: not linked; nothing to change'];
				if (linked.source.kind !== 'local') return [`plugin: '${PLUGIN_ID}' is installed from ${linked.source.kind}, not linked by kalfa; left as it is`];
				if (!dryRun) exec(['plugin', 'unlink', PLUGIN_ID]);
				return [`plugin: unlink ${PLUGIN_ID} (${linked.plugin_root})`];
			}),
	};
}
