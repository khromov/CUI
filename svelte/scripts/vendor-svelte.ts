/**
 * Moves the vendored Svelte to the current head of the custom renderer PR
 * (sveltejs/svelte#18511): pkg.svelte.dev drops builds of commits a force-push removed, so
 * the build this package runs on lives in vendor/.
 *
 *   node scripts/vendor-svelte.ts      then: npm test && npm run typecheck
 */
import { execSync } from 'node:child_process';
import { readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PR = 18511;
const root = fileURLToPath(new URL('..', import.meta.url));
const vendor = join(root, 'vendor');

async function get(url: string) {
	const res = await fetch(url);
	if (!res.ok) throw new Error(`${url} -> ${res.status} ${res.statusText}`);
	return res;
}

const { head } = (await (await get(`https://api.github.com/repos/sveltejs/svelte/pulls/${PR}`)).json()) as { head: { sha: string } };
const short = head.sha.slice(0, 7);
const current = readdirSync(vendor).find((f) => f.endsWith(`-${short}.tgz`));
if (current) {
	console.log(`vendor/${current} is already the PR head (${head.sha})`);
	process.exit(0);
}
const { version } = (await (await get(`https://raw.githubusercontent.com/sveltejs/svelte/${head.sha}/packages/svelte/package.json`)).json()) as { version: string };
const tarball = await (await get(`https://pkg.svelte.dev/svelte/c/${head.sha}`)).arrayBuffer();
for (const f of readdirSync(vendor)) if (f.endsWith('.tgz')) rmSync(join(vendor, f));
const name = `svelte-${version}-${short}.tgz`;
writeFileSync(join(vendor, name), Buffer.from(tarball));
const manifest = join(root, 'package.json');
const json = JSON.parse(readFileSync(manifest, 'utf8'));
json.dependencies.svelte = `file:vendor/${name}`;
writeFileSync(manifest, JSON.stringify(json, null, '\t') + '\n');
execSync('bun install', { cwd: root, stdio: 'inherit' });
console.log(`\nsvelte ${version} @ ${head.sha} -> vendor/${name}\nnow run: npm test && npm run typecheck`);
