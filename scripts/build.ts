// Bundles the CLI into one file that runs on any supported Node, so hooks
// start fast and no machine needs a TypeScript-capable Node.
import { chmodSync, copyFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { adapters } from '../src/adapters/index.ts';
import { build } from 'esbuild';
import { handledEvents } from '../src/core/fast-path.ts';
import { coreModule } from '../src/modules/core.ts';

const outfile = 'dist/kalfa.mjs';
const shim = 'dist/kalfa-hook';

await build({
	entryPoints: ['src/cli/bin.ts'],
	outfile,
	bundle: true,
	minify: true,
	platform: 'node',
	format: 'esm',
	target: 'node22',
	// CommonJS dependencies (yaml) call require() for Node built-ins.
	banner: {
		js: ["#!/usr/bin/env node", "import { createRequire } from 'node:module';", 'const require = createRequire(import.meta.url);'].join('\n'),
	},
});
chmodSync(outfile, 0o755);

// The shim knows the Core's events without starting Node.
writeFileSync(shim, readFileSync('src/cli/kalfa-hook.sh', 'utf8').replace('@CORE_EVENTS@', handledEvents([coreModule]).join(' ')));
chmodSync(shim, 0o755);

// Each Adapter's shell scripts, as dist/adapters/<harness>/<name>: the shim
// runs context-probe; the harness's status line runs status-tap.
for (const name of adapters.keys()) {
	const from = join('src/adapters', name);
	const to = join('dist/adapters', name);
	mkdirSync(to, { recursive: true });
	for (const file of readdirSync(from).filter((f) => f.endsWith('.sh'))) {
		copyFileSync(join(from, file), join(to, file.replace(/\.sh$/, '')));
		chmodSync(join(to, file.replace(/\.sh$/, '')), 0o755);
	}
}
