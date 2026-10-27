import type { ModuleDefinition } from '../core/modules.ts';
import { coreModule } from './core.ts';

/** The Modules this kalfa ships, by name; the Core is one of them. */
export const modules: ReadonlyMap<string, ModuleDefinition> = new Map([coreModule].map((m) => [m.name, m]));
