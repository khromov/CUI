/**
 * The browser build: CUI, the runtime and the app's templates compiled to one wasm module
 * with plain clang + wasm-ld (CUI's web/ shim libc, no Emscripten), next to the JS bundle
 * and a page. CUI and the runtime compile once into a shared object cache.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, join } from 'node:path';
import { PKG_ROOT, type ComponentOutput } from './bundle.ts';
import { CUI_ROOT, cache_root } from './native.ts';

const CFLAGS = [
	'--target=wasm32', '-O2', '-std=c99', '-g0', '-mbulk-memory', '-mnontrapping-fptoint', '-msign-ext', '-msimd128',
	'-fno-stack-protector', '-fno-exceptions', '-ffunction-sections', '-fdata-sections',
	'-Wno-unused-function', '-Wno-unused-variable', '-Wno-unused-but-set-variable', '-Wno-c11-extensions', '-Wno-missing-field-initializers'
];
const LDFLAGS = ['--no-entry', '--gc-sections', '--strip-all', '-z', 'stack-size=4194304', '--initial-memory=33554432', '--max-memory=4294967296'];

function find_tool(env: string, names: string[], dirs: string[]): string | null {
	if (process.env[env]) return process.env[env]!;
	for (const n of names) {
		const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [n], { encoding: 'utf8' });
		if (r.status === 0 && r.stdout.trim()) return r.stdout.trim().split('\n')[0];
		for (const d of dirs) if (existsSync(join(d, n))) return join(d, n);
	}
	return null;
}

const TOOL_DIRS = ['/opt/homebrew/opt/lld/bin', '/opt/homebrew/opt/llvm/bin', '/usr/local/opt/lld/bin', '/usr/local/opt/llvm/bin', '/usr/lib/llvm-19/bin', '/usr/lib/llvm-18/bin'];

export function web_tools(): { cc: string; ld: string } {
	const cc = find_tool('CUISV_CLANG', ['clang'], TOOL_DIRS);
	const ld = find_tool('CUISV_WASM_LD', ['wasm-ld'], TOOL_DIRS);
	if (!cc || !ld) {
		throw new Error(
			`the browser build needs clang with the wasm32 target and wasm-ld (${!cc ? 'no clang' : 'no wasm-ld'} found).\n` +
				'  macOS: brew install lld   Debian/Ubuntu: apt install clang lld   or set CUISV_CLANG / CUISV_WASM_LD'
		);
	}
	return { cc, ld };
}

function run_pool(jobs: (() => Promise<void>)[], n: number): Promise<void> {
	let i = 0;
	const worker = async () => {
		while (i < jobs.length) await jobs[i++]();
	};
	return Promise.all(Array.from({ length: Math.min(n, jobs.length) }, worker)).then(() => {});
}

function compile(cc: string, src: string, obj: string, extra: string[], deps: string[]): () => Promise<void> {
	return () =>
		new Promise((resolve, reject) => {
			if (existsSync(obj)) {
				const t = statSync(obj).mtimeMs;
				if ([src, ...deps].every((d) => !existsSync(d) || statSync(d).mtimeMs <= t)) return resolve();
			}
			const p = spawn(cc, [...CFLAGS, ...extra, '-c', src, '-o', obj], { stdio: ['ignore', 'pipe', 'pipe'] });
			let err = '';
			p.stderr.on('data', (d) => (err += d));
			p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${basename(src)}:\n${err}`))));
		});
}

export interface WebBuild {
	ok: boolean;
	wasm_size: number;
}

/** Compiles the generated C and links app.wasm into `out`. */
export async function build_wasm(components: Map<string, ComponentOutput>, gen_dir: string, out: string): Promise<WebBuild> {
	const { cc, ld } = web_tools();
	const shim = join(CUI_ROOT, 'web', 'shim', 'include');
	const rt = join(PKG_ROOT, 'runtime');
	const inc = ['-isystem', shim, '-I', join(CUI_ROOT, 'include'), '-I', join(CUI_ROOT, 'src'), '-I', join(CUI_ROOT, 'web', 'host'), '-I', rt, '-DCUISV_WEB'];
	const cache = join(cache_root(), 'web');
	mkdirSync(cache, { recursive: true });
	const headers = [join(CUI_ROOT, 'include', 'cui', 'cui.h'), join(CUI_ROOT, 'src', 'cui_internal.h'), join(shim, 'math.h'), join(rt, 'cuisv.h'), join(rt, 'cuisv_internal.h')];
	// the shared part: CUI, the libc shim, CUI's web host and the runtime
	const shared: [string, string, string[]][] = [];
	for (const f of readdirSync(join(CUI_ROOT, 'src'))) if (/^cui_.*\.c$/.test(f)) shared.push([join(CUI_ROOT, 'src', f), join(cache, `lib_${f}.o`), []]);
	shared.push([join(CUI_ROOT, 'src', 'render', 'cui_render_sw.c'), join(cache, 'lib_render_sw.o'), []]);
	shared.push([join(CUI_ROOT, 'web', 'shim', 'libc.c'), join(cache, 'libc.o'), ['-fno-builtin']]);
	shared.push([join(CUI_ROOT, 'web', 'host', 'web_host.c'), join(cache, 'web_host.o'), []]);
	for (const f of ['cuisv.c', 'cuisv_records.c', 'cuisv_cui.c', 'cuisv_services.c', 'cuisv_web.c']) shared.push([join(rt, f), join(cache, `rt_${f}.o`), []]);
	// the app's generated C
	const objdir = join(gen_dir, '..', 'obj');
	mkdirSync(objdir, { recursive: true });
	const app: [string, string, string[]][] = readdirSync(gen_dir)
		.filter((f) => f.endsWith('.c') && f !== 'bundle.c')
		.map((f) => [join(gen_dir, f), join(objdir, f.replace(/\.c$/, '.o')), []]);
	const jobs = [...shared, ...app].map(([src, obj, extra]) => compile(cc, src, obj, [...inc, ...extra], headers));
	await run_pool(jobs, Math.max(2, globalThis.navigator?.hardwareConcurrency ?? 4));
	mkdirSync(out, { recursive: true });
	const wasm = join(out, 'app.wasm');
	const r = spawnSync(ld, [...LDFLAGS, ...[...shared, ...app].map(([, o]) => o), '-o', wasm], { encoding: 'utf8' });
	if (r.status !== 0) throw new Error(`wasm-ld:\n${r.stderr}`);
	void components;
	return { ok: true, wasm_size: statSync(wasm).size };
}

export function write_page(out: string, title: string, dev_reload = false) {
	const reload = dev_reload
		? `<script>new EventSource('/__cuisv_reload').onmessage = () => location.reload();</script>`
		: '';
	writeFileSync(
		join(out, 'index.html'),
		`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title.replace(/</g, '&lt;')}</title>
<link rel="icon" href="data:,">
<style>html, body { margin: 0; height: 100%; overflow: hidden; background: #fff; } @media (prefers-color-scheme: dark) { html, body { background: #111; } }</style>
</head>
<body>
<script type="module" src="./app.js"></script>
${reload}
</body>
</html>
`
	);
}

export function hash_of(s: string) {
	return createHash('sha1').update(s).digest('hex').slice(0, 8);
}

void readFileSync;
