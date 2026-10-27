// What a command reads from and writes to, so tests run commands in process.
import { text } from 'node:stream/consumers';

export interface Io {
	cwd: string;
	env: NodeJS.ProcessEnv;
	stdin(): Promise<string>;
	out(text: string): void;
	err(text: string): void;
}

export const processIo: Io = {
	cwd: process.cwd(),
	env: process.env,
	// An interactive terminal gives no input instead of waiting for it.
	stdin: async () => (process.stdin.isTTY ? '' : text(process.stdin)),
	out: (text) => process.stdout.write(`${text}\n`),
	err: (text) => process.stderr.write(`${text}\n`),
};
