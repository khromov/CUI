#!/usr/bin/env node
// Node >= 24 and Bun run the TypeScript sources as they are. Node will not strip types
// under node_modules, so when cui-svelte is installed there, a load hook strips this
// package's own .ts files (and nothing else).
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname } from 'node:path';

const pkg = pathToFileURL(dirname(dirname(fileURLToPath(import.meta.url))) + '/').href;
if (!globalThis.Bun && pkg.includes('/node_modules/')) {
	const { registerHooks, stripTypeScriptTypes } = await import('node:module');
	const { readFileSync } = await import('node:fs');
	registerHooks({
		load(url, context, next) {
			if (url.startsWith(pkg) && url.endsWith('.ts') && !url.includes('/node_modules/', pkg.length)) {
				return { format: 'module', source: stripTypeScriptTypes(readFileSync(fileURLToPath(url), 'utf8')), shortCircuit: true };
			}
			return next(url, context);
		}
	});
}
await import('../src/cli/main.ts');
