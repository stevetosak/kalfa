// The Core's own handlers. Later sections add the session report (Plans,
// Handoffs, memory budgets).
import { CORE_MODULE, type ModuleDefinition } from '../core/modules.ts';

export const coreModule: ModuleDefinition = {
	name: CORE_MODULE,
	handlers: {},
};
