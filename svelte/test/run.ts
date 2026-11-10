/**
 * Checks the compiler's output against its snapshots (test/codegen) and the CLI (test/cli),
 * then runs every test/**\/*.test.ts headlessly (cui-svelte test <file>), one after another.
 *   node test/run.ts [filter]
 *   CUISV_ENGINE=scriptc node test/run.ts [filter]     the test files on the scriptc build
 */
import { spawnSync } from 'node:child_process';
import { globSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const filter = process.argv[2];
const files = ['test', 'examples']
	.flatMap((d) => globSync(`${d}/**/*.test.ts`, { cwd: root, exclude: ['**/node_modules', '**/dist', '**/dist-web'] }))
	.map((f) => join(root, f))
	.filter((p) => !filter || p.includes(filter));

const scriptc = process.env.CUISV_ENGINE === 'scriptc';
const jobs = files.sort().map((f) => ({ name: relative(root, f), argv: [join(root, 'bin', 'cui-svelte.js'), 'test', f, ...(scriptc ? ['--scriptc'] : [])] }));
// node scripts first: the compiler's output against its snapshots, then the CLI
const scripts = ['codegen/codegen.ts', 'cli/cli.ts'].map((f) => join(root, 'test', f)).filter((p) => !filter || p.includes(filter));
if (!scriptc) jobs.unshift(...scripts.map((p) => ({ name: relative(root, p), argv: [p] })));

let failed = 0;
let skipped = 0;
for (const { name, argv } of jobs) {
	// a test file can name the one engine it is for: `// @engine quickjs: why`
	const only = /^\/\/ @engine (\w+): (.*)$/m.exec(name.endsWith('.test.ts') ? readFileSync(join(root, name), 'utf8') : '');
	if (only && only[1] !== (scriptc ? 'scriptc' : 'quickjs')) {
		skipped++;
		console.log(`skip ${name} (${only[1]} only: ${only[2]})`);
		continue;
	}
	const t0 = performance.now();
	const r = spawnSync(process.execPath, argv, { encoding: 'utf8', env: { ...process.env, CUISV_TEST_TIMEOUT: '60' } });
	const out = (r.stdout ?? '') + (r.stderr ?? '');
	const ok = r.status === 0;
	if (!ok) failed++;
	console.log(`${ok ? 'ok  ' : 'FAIL'} ${name} (${Math.round(performance.now() - t0)} ms)`);
	if (!ok || process.env.VERBOSE) console.log(out.split('\n').map((l) => '     ' + l).join('\n'));
}
const ran = jobs.length - skipped;
console.log((failed ? `${failed} of ${ran} test files failed` : `all ${ran} test files passed`) + (skipped ? `, ${skipped} skipped` : ''));
process.exit(failed ? 1 : 0);
