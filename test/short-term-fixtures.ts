// A repository with Task Records for the tests of Short-term memory (the
// window and the Migration): Plans in each state, one commit on 2026-03-01,
// the session days 2026-03-02 to 2026-03-06, and a machine with the memory
// Module on.
import { execFileSync } from 'node:child_process';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeCheckpoint } from '../src/core/checkpoint.ts';
import { memoryHome, projectLayerOfKey } from '../src/core/memory/home.ts';
import { loadProject, type Project } from '../src/core/project.ts';
import { type TaskHeader, writeRecord } from '../src/core/task-record.ts';
import { gitRepo, tempRepo } from './helpers.ts';

/** The project key of the fixture's remote. */
export const KEY = 'github.com/someone/project';

/** Active days 2026-03-01 to 2026-03-06: five of them after a close on 2026-03-01. */
export const DAYS = ['2026-03-01', '2026-03-02', '2026-03-03', '2026-03-04', '2026-03-05', '2026-03-06'];

const plan = (status: string) => `---\ntype: plan\ntitle: A Plan\nstatus: ${status}\n---\n\n# A Plan\n\n- [ ] A step.\n`;

/** A Task header, closed and reconciled on 2026-03-01 unless `fields` say otherwise. */
export const header = (fields: Partial<TaskHeader> = {}): TaskHeader => ({
	schema: 1,
	goal: 'A goal',
	status: 'closed',
	started: '2026-03-01',
	closed: '2026-03-01',
	reconciled: '2026-03-01',
	...fields,
});

function git(root: string, ...args: string[]): void {
	const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_COMMITTER_DATE: '2026-03-01T12:00:00', GIT_AUTHOR_DATE: '2026-03-01T12:00:00' };
	execFileSync('git', ['-C', root, ...args], { env, stdio: 'ignore' });
}

/** The repository and the machine; `settings` is more YAML for the machine's config. */
export function setup(settings = '') {
	const root = realpathSync(
		gitRepo({
			'kalfa.yaml': 'schema: 1\nmodules: []\n',
			'.gitignore': '.kalfa/\n',
			'docs/plan-open.md': plan('active'),
			'docs/plan-done.md': plan('done'),
			'docs/plan-broken.md': plan('unknown'),
		}),
	);
	git(root, 'add', '.');
	git(root, 'commit', '-q', '-m', 'first');
	git(root, 'remote', 'add', 'origin', 'git@github.com:Someone/Project.git');
	mkdirSync(join(root, '.kalfa'), { recursive: true });
	writeFileSync(join(root, '.kalfa/active-days'), `${DAYS.slice(1).join('\n')}\n`);
	const machine = tempRepo({ '.config/kalfa/config.yaml': `schema: 1\nmodules: [memory]\n${settings}` });
	const env = { HOME: machine } as NodeJS.ProcessEnv;
	const project = loadProject(root) as Project;
	const write = (id: string, fields: Partial<TaskHeader> = {}, next = 'Nothing.') =>
		writeRecord(root, { id, header: header(fields), sections: [{ title: `Work on ${id}`, parts: new Map([['Done', `The zeppelin work of ${id}.`], ['Next', next]]) }] });
	const checkpoint = (task: string, at: string) => writeCheckpoint(root, { task, trigger: 'auto', at, summary: `Where ${task} stood at ${at}.` });
	return { root, env, home: memoryHome(env), project, write, checkpoint };
}

/** A path in the fixture project's folder of the Memory home, where the archive is. */
export const archived = (home: string, ...path: string[]) => join(projectLayerOfKey(home, KEY).dir, ...path);

/** The subjects of the Memory home's commits, the newest first. */
export const homeLog = (home: string) => execFileSync('git', ['-C', home, 'log', '--format=%s'], { encoding: 'utf8' }).trim().split('\n');
