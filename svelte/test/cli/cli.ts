/**
 * The CLI around the compiler, run by node rather than in QuickJS: native builds that follow
 * components as they are added, renamed, removed and edited in quick succession, a headless
 * test that never finishes, the component cache of `dev`, what `dev` watches, and the API
 * extraction the component table is built on.
 *
 *   node test/cli/cli.ts
 *
 * The projects live in one folder under the system's temporary folder, kept between runs so
 * the shared native build tree keeps the same list of apps.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PKG_ROOT, bundle, reset_globals, type ComponentOutput } from '../../src/cli/bundle.ts';
import { project_root, triggers_rebuild } from '../../src/cli/project.ts';

const CLI = join(PKG_ROOT, 'bin', 'cui-svelte.js');
// the real path: esbuild reports files by theirs (macOS's temporary folder is behind a symlink)
const BASE = join(realpathSync(tmpdir()), `cui-svelte-cli-${createHash('sha1').update(PKG_ROOT).digest('hex').slice(0, 8)}`);

let failed = 0;
async function check(name: string, fn: () => void | Promise<void>) {
	try {
		await fn();
		console.log(`  ok   ${name}`);
	} catch (e) {
		failed++;
		console.log(`  FAIL ${name}\n       ${String((e as Error).message ?? e).split('\n').join('\n       ')}`);
	}
}

function assert(ok: unknown, message: string): asserts ok {
	if (!ok) throw new Error(message);
}

/** A fresh project folder, except for its build output (.cui-svelte), which stays. */
function project(name: string): string {
	const dir = join(BASE, name);
	mkdirSync(dir, { recursive: true });
	for (const f of readdirSync(dir)) if (f !== '.cui-svelte') rmSync(join(dir, f), { recursive: true, force: true });
	return dir;
}

function cui_test(dir: string, file: string) {
	const r = spawnSync(process.execPath, [CLI, 'test', file], { cwd: dir, encoding: 'utf8', env: { ...process.env, CUISV_TEST_TIMEOUT: '30' } });
	return { status: r.status, out: (r.stdout ?? '') + (r.stderr ?? '') };
}

await check('native builds follow components as they are added, renamed, removed and edited', () => {
	const dir = project('components');
	const steps: [string, [string, string][]][] = [
		['A alone', [['A', 'from A']]],
		['B added', [['A', 'from A'], ['B', 'from B']]],
		['B renamed to C', [['A', 'from A'], ['C', 'from C']]],
		['C removed', [['A', 'from A']]],
		// at once after the build before: in the same second, which some makes cannot tell apart
		['A edited', [['A', 'edited A']]],
		['A edited again', [['A', 'edited A again']]]
	];
	for (const [step, parts] of steps) {
		for (const f of readdirSync(dir)) if (f.endsWith('.svelte')) rmSync(join(dir, f));
		for (const [name, text] of parts) writeFileSync(join(dir, `${name}.svelte`), `<script>\n\timport { Text } from 'cui-svelte';\n</script>\n\n<Text>${text}</Text>\n`);
		writeFileSync(
			join(dir, 'app.test.ts'),
			[
				`import { mount_test, test, expect } from 'cui-svelte/test';`,
				...parts.map(([name]) => `import ${name} from './${name}.svelte';`),
				`test(${JSON.stringify(step)}, () => {`,
				...parts.map(([name, text]) => `\texpect(mount_test(${name}, { width: 300, height: 100 }).text()).toContain(${JSON.stringify(text)});`),
				'});',
				''
			].join('\n')
		);
		const r = cui_test(dir, 'app.test.ts');
		assert(r.status === 0 && r.out.includes(`ok   ${step}`) && r.out.includes('1/1 passed'), `${step}: exit ${r.status}\n${r.out}`);
	}
});

await check('a headless test that never finishes fails, and says which', () => {
	const dir = project('unfinished');
	writeFileSync(
		join(dir, 'hang.test.ts'),
		`import { test, expect } from 'cui-svelte/test';\n\ntest('waits for nothing', async () => {\n\tawait new Promise(() => {});\n\texpect(1).toBe(2);\n});\n`
	);
	const r = cui_test(dir, 'hang.test.ts');
	assert(r.status === 1, `exit ${r.status}\n${r.out}`);
	assert(r.out.includes('FAIL waits for nothing') && r.out.includes('the tests did not finish'), r.out);
});

await check('the component cache follows the :root and :global rules of other components', async () => {
	const dir = project('globals');
	const app = (brand: string, pad: number) =>
		writeFileSync(
			join(dir, 'App.svelte'),
			`<script>\n\timport Child from './Child.svelte';\n</script>\n\n<Child />\n\n<style>\n\t:root { --brand: ${brand}; }\n\t:global(.note) { padding: ${pad}px; }\n</style>\n`
		);
	app('#ff0000', 4);
	writeFileSync(join(dir, 'Child.svelte'), `<div class="note box">child</div>\n\n<style>\n\t.box { background: var(--brand); }\n</style>\n`);
	writeFileSync(join(dir, 'main.ts'), `import { run } from 'cui-svelte';\nimport App from './App.svelte';\nrun(App);\n`);
	const cache = new Map<string, { source: string; out: ComponentOutput }>();
	const child_c = async () => {
		reset_globals(); // as dev does before each rebuild
		const b = await bundle({ entry: join(dir, 'main.ts'), root: dir, dev: true, cache });
		assert(!b.errors.length, b.errors.join('\n'));
		const child = [...b.components.values()].find((c) => c.key === 'Child.svelte');
		assert(child, 'no Child.svelte in the bundle');
		return child.result.c;
	};
	const before = await child_c();
	assert(before.includes('{ 255, 0, 0, 255 }') && before.includes('pad_top = 4.0f'), before);
	assert((await child_c()) === before, 'the same sources compiled differently');
	app('#0000ff', 20);
	const after = await child_c();
	assert(after.includes('{ 0, 0, 255, 255 }') && after.includes('pad_top = 20.0f'), `Child.svelte kept the old globals:\n${after}`);
});

await check('dev rebuilds for sources and the C next to components, not for build output', () => {
	for (const f of ['App.svelte', 'Host.svelte.c', 'lib/util.ts', 'data.json', 'style.css', 'src/a.mjs', 'main.js']) assert(triggers_rebuild(f), `${f} should rebuild`);
	for (const f of ['.cui-svelte/dev/gen/c_App_svelte.c', 'dist-web/app.js', 'dist/app', 'node_modules/x/index.js', '.git/index', 'README.md', 'icon.png', null])
		assert(!triggers_rebuild(f), `${f} should not rebuild`);
});

await check('a project inside this package is its entry folder', () => {
	const entry = join(PKG_ROOT, 'test', 'basics', 'basics.test.ts');
	// PKG_ROOT is a path; a URL's pathname would be percent-encoded (spaces, accents) and miss it
	assert(project_root(entry) === join(PKG_ROOT, 'test', 'basics'), `${project_root(entry)} for ${entry}`);
});

await check('cui-api.json: each function has its own comment, not the prototype above it', () => {
	const api = JSON.parse(readFileSync(join(PKG_ROOT, 'src', 'compiler', 'cui-api.json'), 'utf8')) as { functions: Record<string, { name: string; comment?: string }> };
	const wrong = Object.values(api.functions).filter((f) => f.comment?.includes('CUI_API'));
	assert(!wrong.length, `${wrong.length} comments hold a prototype: ${wrong.map((f) => f.name).join(', ')}`);
	assert(api.functions.cui_frame_count && !api.functions.cui_frame_count.comment, `cui_frame_count: ${api.functions.cui_frame_count?.comment}`);
});

console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);
