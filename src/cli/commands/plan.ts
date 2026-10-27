// `kalfa plan`: the Plans that the project file's `plans:` globs find. The
// session report shows the open ones; these commands serve a harness without
// that report, and `check` serves CI.
import { KalfaError } from '../../core/errors.ts';
import { findPlans, isOpenPlan, openAnywhere, type Plan, planStepProblems, planSummary, type PlanStep } from '../../core/plans.ts';
import { PROJECT_FILE, type Project } from '../../core/project.ts';
import { type Command, parseCommandArgs, UsageError } from '../command.ts';
import type { Io } from '../io.ts';
import { requireProject } from '../project.ts';

function plansOf(project: Project): ReturnType<typeof findPlans> {
	const globs = project.file?.plans ?? [];
	if (!globs.length) throw new KalfaError(`no Plans: list their globs under 'plans:' in ${PROJECT_FILE}`);
	return findPlans(project.root, globs);
}

const stepLine = (step: PlanStep, indent: string) => `${indent}- line ${step.line}: ${step.text}`;

function openSteps(steps: PlanStep[], indent = ''): string[] {
	return steps.flatMap((step) => {
		const subs = openSteps(step.subItems, `${indent}  `);
		if (step.state === 'open') return [stepLine(step, indent), ...subs];
		// A done step with open sub-items is shown so the sub-items keep their parent.
		return step.state === 'done' && subs.length ? [`${indent}- line ${step.line} (done): ${step.label}`, ...subs] : [];
	});
}

const subcommands: Record<string, (args: string[], io: Io) => Promise<number>> = {
	async list(args, io) {
		const { values } = parseCommandArgs(args, { all: { type: 'boolean' } });
		const { plans, problems } = plansOf(requireProject(io));
		const shown = values.all ? plans : plans.filter(isOpenPlan);
		if (!shown.length) io.out(values.all ? 'no Plans' : 'no open Plans (--all shows every Plan)');
		for (const plan of shown) io.out(planSummary(plan));
		for (const problem of problems) io.err(`kalfa: ${problem}`);
		return 0;
	},
	async show(args, io) {
		const { positionals } = parseCommandArgs(args, {}, true);
		const [path] = positionals;
		if (!path || positionals.length > 1) throw new UsageError('give one Plan path');
		const { plans } = plansOf(requireProject(io));
		const plan: Plan | undefined = plans.find((p) => p.path === path);
		if (!plan) throw new KalfaError(`no Plan '${path}' among the ones the plans: globs find (kalfa plan list --all)`);
		const steps = openSteps(plan.steps);
		io.out([planSummary(plan), '', steps.length ? 'Open steps:' : 'No open steps.', ...steps].join('\n'));
		return 0;
	},
	async check(args, io) {
		parseCommandArgs(args, {});
		const { plans, problems } = plansOf(requireProject(io));
		const all = [...problems, ...plans.flatMap((plan) => planStepProblems(plan).map((p) => `${plan.path}: ${p}`))];
		for (const problem of all) io.err(problem);
		if (all.length) return 1;
		io.out(`${plans.length} Plan(s), ${openAnywhere(plans.flatMap((p) => p.steps)).length} open step(s): no problems`);
		return 0;
	},
};

export const planCommand: Command = {
	summary: 'List, show or check the Plans of this repository',
	usage: 'kalfa plan list [--all]\n       kalfa plan show <path>\n       kalfa plan check',
	async run(args, io) {
		const [sub, ...rest] = args;
		const run = sub && Object.hasOwn(subcommands, sub) ? subcommands[sub] : undefined;
		if (!run) throw new UsageError(sub ? `unknown subcommand '${sub}'` : 'give a subcommand');
		return run(rest, io);
	},
};
