/**
 * Where an app's project starts, and which of its files `cui-svelte dev` (native and --web)
 * rebuilds for.
 */
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { PKG_ROOT } from './bundle.ts';

/**
 * The folder of the nearest package.json above the entry (template ids and messages use paths
 * relative to it), or `given` (--root). A project inside this package (the examples, the tests)
 * is its entry's own folder instead.
 */
export function project_root(entry: string, given?: string): string {
	if (given) return resolve(given);
	let dir = dirname(resolve(entry));
	for (let d = dir; ; d = dirname(d)) {
		if (existsSync(join(d, 'package.json'))) {
			dir = d;
			break;
		}
		if (dirname(d) === d) break;
	}
	// PKG_ROOT is a path (fileURLToPath), not a URL's pathname: spaces and other characters stay as they are
	return dir === resolve(PKG_ROOT) ? dirname(resolve(entry)) : dir;
}

/** Build output, dependencies and version control: changes there never start a rebuild. */
const IGNORED = /(^|[\\/])(\.cui-svelte|node_modules|dist|dist-web|\.git)([\\/]|$)/;
/** Components, scripts, data, styles, and the C next to a component (`Component.svelte.c`). */
const SOURCES = /\.(svelte|ts|js|mjs|json|css|c)$/;

/** Whether a change to `file` (relative to the watched project) should rebuild the app. */
export function triggers_rebuild(file: string | null | undefined): boolean {
	return !!file && !IGNORED.test(file) && SOURCES.test(file);
}
