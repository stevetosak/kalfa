// The `--layer` option of the commands that write into the Memory home
// (`kalfa memory`, `kalfa rule`, `kalfa defer`): which layer a name means,
// as the working directory sees it.
import { KalfaError } from '../core/errors.ts';
import { type Layer, type LayerName, memoryHome, personalLayer, projectLayer, sessionLayers } from '../core/memory/home.ts';
import { loadProject } from '../core/project.ts';
import { UsageError } from './command.ts';
import type { Io } from './io.ts';

/** Parses a --layer value. */
export function layerName(value: string | undefined): LayerName | undefined {
	if (value === undefined) return undefined;
	if (value !== 'personal' && value !== 'project') throw new UsageError(`--layer is personal or project, not '${value}'`);
	return value;
}

/** The layer named by --layer, as this directory sees it. */
export function layerFor(io: Io, name: LayerName): Layer {
	const home = memoryHome(io.env);
	if (name === 'personal') return personalLayer(home);
	const project = loadProject(io.cwd);
	if (!project) throw new KalfaError('the project layer needs a git repository; run this inside one, or use --layer personal');
	return projectLayer(home, project);
}

/** The layers to look in for an id: the one named, else every layer this directory sees. */
export function layersFor(io: Io, name: LayerName | undefined): Layer[] {
	return name ? [layerFor(io, name)] : sessionLayers(memoryHome(io.env), loadProject(io.cwd));
}
