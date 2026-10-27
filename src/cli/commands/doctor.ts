// Reports what kalfa sees on this machine and in this repository. Later
// sections add the harness Capabilities, the install mode and stale files.
import { existsSync } from 'node:fs';
import { loadProject, PROJECT_FILE } from '../../core/project.ts';
import { loadSettings, settingsPath } from '../../core/settings.ts';
import { type Command, parseCommandArgs } from '../command.ts';

export const doctor: Command = {
	summary: 'Report what kalfa sees on this machine and in this repository',
	usage: 'kalfa doctor',
	async run(args, io) {
		parseCommandArgs(args, {});
		const path = settingsPath(io.env);
		loadSettings(io.env);
		io.out(`machine settings: ${path}${existsSync(path) ? '' : ' (not found, defaults)'}`);

		const project = loadProject(io.cwd);
		if (!project) {
			io.out('project: none (not in a git repository)');
			return 0;
		}
		io.out(`project: ${project.root}`);
		if (!project.file) {
			io.out(`project file: none (no ${PROJECT_FILE}, Core only)`);
			return 0;
		}
		const modules = project.file.modules.length ? project.file.modules.join(', ') : 'none';
		io.out(`project file: ${PROJECT_FILE} schema ${project.file.schema}; Modules: ${modules}`);
		return 0;
	},
};
