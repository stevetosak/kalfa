// `kalfa recap`: where the work of this repository stood, from the Plans, the
// Task Records, the Checkpoints and git. `/where-was-i` reads it; a session
// start after some idle days shows it unasked.
import { recapView } from '../../core/recap.ts';
import { type Command, parseCommandArgs } from '../command.ts';
import { requireProject } from '../project.ts';

export const recapCommand: Command = {
	summary: 'Where the work stood: the Plan part, the last Task with its Decisions and Next, its last Checkpoint, the commits since and the other open Tasks',
	usage: 'kalfa recap [--task <id>]',
	async run(args, io) {
		const { values } = parseCommandArgs(args, { task: { type: 'string' } });
		const project = requireProject(io);
		io.out(recapView(project.root, project.file?.plans ?? [], { task: values.task }));
		return 0;
	},
};
