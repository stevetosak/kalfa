// The entry point of the bundle (`dist/kalfa.mjs`).
import { processIo } from './io.ts';
import { main } from './main.ts';

// A reader that closes the pipe early (`kalfa doctor | head -1`) is not an error.
process.stdout.on('error', (error: NodeJS.ErrnoException) => {
	if (error.code !== 'EPIPE') throw error;
	process.exit(0);
});

process.exitCode = await main(process.argv.slice(2), processIo);
