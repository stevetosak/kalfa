// The herdr Module's Herdr plugin, in herdr-plugin/. Herdr lists its actions
// in the pane menu and runs them with no terminal, so an action only opens one
// of the plugin's popup panes (`kalfa space popup <pane>`), in the folder of
// the Workspace it was run from; the pane has a terminal and runs the form
// (`kalfa space new`). The manifest names kalfa commands only, so the logic
// stays here, tested. The commands need `kalfa` on Herdr's PATH.
import { KalfaError } from '../../src/core/errors.ts';
import type { HerdrExec } from './launcher.ts';
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
