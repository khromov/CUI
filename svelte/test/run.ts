/**
 * Runs every test/**\/*.test.ts headlessly (cui-svelte test <file>), one after another.
 *   node test/run.ts [filter]
 */
import { spawnSync } from 'node:child_process';
import { globSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const filter = process.argv[2];
const files = ['test', 'examples']
	.flatMap((d) => globSync(`${d}/**/*.test.ts`, { cwd: root, exclude: ['**/node_modules', '**/dist', '**/dist-web'] }))
	.map((f) => join(root, f))
	.filter((p) => !filter || p.includes(filter));

let failed = 0;
for (const f of files.sort()) {
	const t0 = performance.now();
	const r = spawnSync(process.execPath, [join(root, 'bin', 'cui-svelte.js'), 'test', f], { encoding: 'utf8', env: { ...process.env, CUISV_TEST_TIMEOUT: '60' } });
	const out = (r.stdout ?? '') + (r.stderr ?? '');
	const ok = r.status === 0;
	if (!ok) failed++;
	console.log(`${ok ? 'ok  ' : 'FAIL'} ${relative(root, f)} (${Math.round(performance.now() - t0)} ms)`);
	if (!ok || process.env.VERBOSE) console.log(out.split('\n').map((l) => '     ' + l).join('\n'));
}
console.log(failed ? `${failed} of ${files.length} test files failed` : `all ${files.length} test files passed`);
process.exit(failed ? 1 : 0);
