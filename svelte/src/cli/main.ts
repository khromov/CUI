/**
 * cui-svelte CLI.
 *
 *   cui-svelte build <entry.ts> [--debug] [--out <file>]   native binary with the bundle inside
 *   cui-svelte build <entry.ts> --web [--out <dir>]        the browser build: index.html, app.js, app.wasm
 *   cui-svelte build <entry.ts> --app [--out <dir>]        a macOS application, Name.app, in dist/
 *        [--name Name] [--id com.example.app] [--app-version 1.0.0] [--icon icon.png] [--sign identity]
 *        [--notarize <notarytool keychain profile>]
 *   cui-svelte dev   <entry.ts> --web [--port 5174]        serve the browser build, reloading on save
 *   cui-svelte run   <entry.ts> [--release]                build, then start it
 *   cui-svelte dev   <entry.ts>                            run, and reload on save: script edits
 *                                                          hot-swap in the running window, markup
 *                                                          and style edits rebuild the C and relaunch
 *   cui-svelte test  <file.test.ts>                        headless build that runs a test file
 *   cui-svelte build|run|test <entry.ts> --scriptc         experimental: the JS compiled to native code
 *                                                          by scriptc instead of run by QuickJS
 *   cui-svelte compile <file.svelte>                       print the C and JS of one component
 *   cui-svelte create  <dir>                               a new app to start from
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, watch, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { bundle, reset_globals, type ComponentOutput } from './bundle.ts';
import { app_name, cmake_build, write_sources } from './native.ts';
import { build_wasm, write_page } from './web.ts';
import { developer_id, make_app_bundle, notarize, run_options } from './macos.ts';
import { compile } from '../compiler/index.ts';
import { create } from './create.ts';
import { project_root, triggers_rebuild } from './project.ts';

const OPTIONS = {
	release: { type: 'boolean' }, debug: { type: 'boolean' }, verbose: { type: 'boolean', short: 'v' }, web: { type: 'boolean' }, app: { type: 'boolean' }, scriptc: { type: 'boolean' },
	out: { type: 'string', short: 'o' }, root: { type: 'string' }, port: { type: 'string', default: '5174' },
	name: { type: 'string' }, id: { type: 'string' }, 'app-version': { type: 'string' }, icon: { type: 'string' }, sign: { type: 'string' }, notarize: { type: 'string' },
	help: { type: 'boolean', short: 'h' }
} as const;

/** Flags, then the command, the entry and what the app gets (anything after `--` too). */
function parse_args(argv: string[]) {
	let parsed;
	try {
		parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true });
	} catch (e) {
		console.error(`cui-svelte: ${(e as Error).message.split('. ')[0]}; arguments for the app go after --`);
		process.exit(1);
	}
	const { values: v, positionals } = parsed;
	const [cmd = 'help', entry = '', ...rest] = v.help ? ['help'] : positionals;
	// build makes a release unless --debug; run and dev make a debug build unless --release
	const release = cmd === 'build' ? !v.debug : !!v.release && !v.debug;
	return { ...v, cmd, entry, rest, release, scriptc: !!v.scriptc, app_version: v['app-version'], port: Number(v.port), verbose: !!v.verbose, web: !!v.web, app: !!v.app };
}
type Args = ReturnType<typeof parse_args>;

const dim = (s: string) => (process.stderr.isTTY ? `\x1b[2m${s}\x1b[0m` : s);
const red = (s: string) => (process.stderr.isTTY ? `\x1b[31m${s}\x1b[0m` : s);
const yellow = (s: string) => (process.stderr.isTTY ? `\x1b[33m${s}\x1b[0m` : s);

interface Built {
	ok: boolean;
	binary: string;
	js: string;
	components: Map<string, ComponentOutput>;
	c_changed: boolean;
}

const cache = new Map<string, { source: string; out: ComponentOutput }>();

async function build_once(a: Args, mode: 'dev' | 'release' | 'debug' | 'test', quiet_warnings = new Set<string>()): Promise<Built> {
	const entry = resolve(a.entry);
	const root = project_root(entry, a.root);
	const t0 = performance.now();
	const b = await bundle({ entry, root, dev: mode !== 'release', minify: mode === 'release', cache });
	for (const w of b.warnings) {
		if (quiet_warnings.has(w)) continue;
		quiet_warnings.add(w);
		console.error(yellow('warning ') + w);
	}
	if (b.errors.length) {
		for (const e of b.errors) console.error(red('error ') + e);
		return { ok: false, binary: '', js: '', components: b.components, c_changed: false };
	}
	const t1 = performance.now();
	const dir = join(root, '.cui-svelte', mode);
	const name = app_name(entry);
	const native = { dir, name, release: mode === 'release', embed: mode !== 'dev', test: mode === 'test', verbose: a.verbose };
	const { changed } = write_sources(native, b.components, b.js);
	let binary = '';
	let ok = true;
	const r = cmake_build(native);
	ok = r.ok;
	binary = r.binary;
	if (!ok) console.error(r.log.split('\n').filter((l) => /error|undefined/i.test(l) || a.verbose).join('\n') || r.log);
	const t2 = performance.now();
	console.error(dim(`bundled ${b.components.size} components in ${Math.round(t1 - t0)} ms, native build ${Math.round(t2 - t1)} ms`));
	return { ok, binary, js: b.js, components: b.components, c_changed: changed };
}

// ---- the scriptc build (experimental) ---------------------------------------------------------

/** Builds with scriptc; the binary is the windowed app, or the headless test host with CUISV_HEADLESS=1. */
async function build_with_scriptc(a: Args, dev: boolean): Promise<string> {
	const entry = resolve(a.entry);
	const root = project_root(entry, a.root);
	const out = a.out ? resolve(a.out) : join(dirname(entry), 'dist', app_name(entry) + '-scriptc' + (process.platform === 'win32' ? '.exe' : ''));
	// loaded only here: this build needs the typescript package, which the others do not
	const { build_scriptc } = await import('./scriptc.ts');
	const r = await build_scriptc({ entry, root, dir: join(root, '.cui-svelte', dev ? 'scriptc-dev' : 'scriptc'), out, dev, verbose: a.verbose });
	for (const w of r.warnings) console.error(yellow('warning ') + w);
	if (!r.ok) {
		console.error(red('error ') + r.log);
		process.exit(1);
	}
	console.error(dim(`bundled in ${Math.round(r.ms.bundle)} ms, C ${Math.round(r.ms.c)} ms, scriptc ${Math.round(r.ms.scriptc)} ms`));
	return out;
}

// ---- the browser build ---------------------------------------------------------------------

async function build_web(a: Args, out: string, dev: boolean, quiet = new Set<string>()): Promise<boolean> {
	const entry = resolve(a.entry);
	const root = project_root(entry, a.root);
	const t0 = performance.now();
	const b = await bundle({ entry, root, dev, minify: !dev, cache, target: 'web' });
	for (const w of b.warnings) {
		if (quiet.has(w)) continue;
		quiet.add(w);
		console.error(yellow('warning ') + w);
	}
	if (b.errors.length) {
		for (const e of b.errors) console.error(red('error ') + e);
		return false;
	}
	const dir = join(root, '.cui-svelte', 'web');
	write_sources({ dir, name: app_name(entry), release: !dev, embed: false }, b.components, '');
	const t1 = performance.now();
	try {
		const w = await build_wasm(b.components, join(dir, 'gen'), out);
		mkdirSync(out, { recursive: true });
		writeFileSync(join(out, 'app.js'), b.js);
		write_page(out, app_name(entry), dev);
		console.error(dim(`bundled ${b.components.size} components in ${Math.round(t1 - t0)} ms, wasm (${Math.round(w.wasm_size / 1024)} KB) in ${Math.round(performance.now() - t1)} ms`));
		return true;
	} catch (e) {
		console.error(red('error ') + (e as Error).message);
		return false;
	}
}

async function serve_web(a: Args) {
	const entry = resolve(a.entry);
	const root = project_root(entry, a.root);
	const out = join(root, '.cui-svelte', 'web', 'out');
	const quiet = new Set<string>();
	await build_web(a, out, true, quiet);
	const clients = new Set<import('node:http').ServerResponse>();
	const { createServer } = await import('node:http');
	const types: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.wasm': 'application/wasm', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' };
	const server = createServer((req, res) => {
		const url = new URL(req.url ?? '/', 'http://x');
		if (url.pathname === '/__cuisv_reload') {
			res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
			res.write('\n');
			clients.add(res);
			req.on('close', () => clients.delete(res));
			return;
		}
		const file = join(out, url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname));
		if (!file.startsWith(out) || !existsSync(file)) {
			res.writeHead(404).end('not found');
			return;
		}
		res.writeHead(200, { 'content-type': types[file.slice(file.lastIndexOf('.'))] ?? 'application/octet-stream', 'cache-control': 'no-store' });
		res.end(readFileSync(file));
	});
	server.listen(a.port, () => console.error(`serving http://localhost:${a.port}`));
	let timer: ReturnType<typeof setTimeout> | null = null;
	let busy = false;
	const rebuild = async () => {
		if (busy) return void (timer = setTimeout(rebuild, 100));
		busy = true;
		reset_globals();
		const ok = await build_web(a, out, true, quiet);
		busy = false;
		if (ok) for (const c of clients) c.write('data: reload\n\n');
	};
	watch(root, { recursive: true }, (_e, file) => {
		if (!triggers_rebuild(file)) return;
		if (timer) clearTimeout(timer);
		timer = setTimeout(rebuild, 60);
	});
}

async function cmd_build(a: Args) {
	if (a.web) {
		const out = a.out ? resolve(a.out) : join(dirname(resolve(a.entry)), 'dist-web');
		if (!(await build_web(a, out, false))) process.exit(1);
		console.error(`built ${relative(process.cwd(), out)}/ (index.html, app.js, app.wasm): serve it with any static file server`);
		return;
	}
	if (a.scriptc) {
		const out = await build_with_scriptc(a, !a.release);
		console.error(`built ${relative(process.cwd(), out)}`);
		return;
	}
	const r = await build_once(a, a.release ? 'release' : 'debug');
	if (!r.ok) process.exit(1);
	if (a.app) return build_app(a, r.binary);
	const out = a.out ? resolve(a.out) : join(dirname(resolve(a.entry)), 'dist', app_name(resolve(a.entry)) + (process.platform === 'win32' ? '.exe' : ''));
	mkdirSync(dirname(out), { recursive: true });
	copyFileSync(r.binary, out);
	console.error(`built ${relative(process.cwd(), out)}`);
}

/**
 * Name.app around the binary. Name and identifier come from the flags, else from the title
 * and app_id given to run() in the entry, else from the entry's folder; the version from the
 * flag, else the project's package.json; the icon from --icon, else an icon.png by the entry.
 */
function build_app(a: Args, binary: string) {
	const entry = resolve(a.entry);
	const root = project_root(entry, a.root);
	const given = run_options(entry);
	const folder = app_name(entry);
	const name = a.name ?? given.title ?? folder.charAt(0).toUpperCase() + folder.slice(1);
	const slug = (given.app_id ?? name).toLowerCase().replace(/[^a-z0-9.-]+/g, '-').replace(/^-+|-+$/g, '') || 'app';
	const id = a.id ?? (slug.includes('.') ? slug : `local.${slug}`);
	let version = a.app_version;
	const pkg = join(root, 'package.json');
	if (!version && existsSync(pkg)) {
		const p = JSON.parse(readFileSync(pkg, 'utf8')) as { name?: string; version?: string };
		if (p.name !== 'cui-svelte') version = p.version;
	}
	const icon = a.icon ? resolve(a.icon) : existsSync(join(dirname(entry), 'icon.png')) ? join(dirname(entry), 'icon.png') : undefined;
	try {
		// notarizing needs a Developer ID signature: the keychain's own when --sign leaves it open
		const sign = a.sign ?? (a.notarize ? developer_id() : undefined);
		const app = make_app_bundle({ binary, out_dir: a.out ? resolve(a.out) : join(dirname(entry), 'dist'), name, id, version: version ?? '1.0.0', icon, sign });
		console.error(`built ${relative(process.cwd(), app)} (${id}${icon ? '' : ', no icon: add icon.png by the entry or pass --icon'}), signed ${sign ? `by ${sign}` : 'ad hoc'}`);
		if (a.notarize) {
			if (!sign || sign === '-') throw new Error('--notarize needs a Developer ID signature, not ad hoc');
			notarize(app, a.notarize, (s) => console.error(s));
			console.error(`notarized and stapled ${relative(process.cwd(), app)}: it opens on any Mac`);
		}
	} catch (e) {
		console.error(red('error ') + (e as Error).message);
		process.exit(1);
	}
}

function launch(binary: string, env: Record<string, string>, rest: string[]): ChildProcess {
	return spawn(binary, rest, { stdio: 'inherit', env: { ...process.env, ...env } });
}

async function cmd_run(a: Args) {
	if (a.scriptc) {
		const child = launch(await build_with_scriptc(a, !a.release), {}, a.rest);
		child.on('exit', (code) => process.exit(code ?? 0));
		return;
	}
	const r = await build_once(a, a.release ? 'release' : 'debug');
	if (!r.ok) process.exit(1);
	const child = launch(r.binary, {}, a.rest);
	child.on('exit', (code) => process.exit(code ?? 0));
}

async function cmd_dev(a: Args) {
	if (a.web) return serve_web(a);
	const entry = resolve(a.entry);
	const root = project_root(entry, a.root);
	const warned = new Set<string>();
	const bundle_file = join(root, '.cui-svelte', 'dev', 'app.js');
	// the running app reloads when this file changes, so it is written only once it should
	const write_bundle = (js: string) => {
		writeFileSync(bundle_file + '.tmp', js);
		renameSync(bundle_file + '.tmp', bundle_file);
	};
	let r = await build_once(a, 'dev', warned);
	if (!r.ok) console.error(red('fix the errors above; watching for changes'));
	else write_bundle(r.js);
	let child: ChildProcess | null = null;
	const start = () => {
		if (!r.ok || !existsSync(r.binary)) return;
		child = launch(r.binary, { CUISV_BUNDLE: bundle_file }, a.rest);
		child.on('exit', (code, signal) => {
			if (signal !== 'SIGTERM') process.exit(code ?? 0);
		});
	};
	start();
	let timer: ReturnType<typeof setTimeout> | null = null;
	let busy = false;
	const rebuild = async () => {
		if (busy) return void (timer = setTimeout(rebuild, 100));
		busy = true;
		try {
			const before = r;
			reset_globals();
			r = await build_once(a, 'dev', warned);
			if (!r.ok) return;
			if (r.c_changed || !before.ok || !child) {
				console.error(dim('markup changed: relaunching'));
				if (child) {
					const old: ChildProcess = child;
					child = null;
					old.kill('SIGTERM');
				}
				write_bundle(r.js);
				start();
			} else {
				write_bundle(r.js);
				console.error(dim('script changed: reloaded in place'));
			}
		} finally {
			busy = false;
		}
	};
	watch(root, { recursive: true }, (_e, file) => {
		if (!triggers_rebuild(file)) return;
		if (timer) clearTimeout(timer);
		timer = setTimeout(rebuild, 60);
	});
	const shown = relative(process.cwd(), root);
	console.error(dim(`watching ${shown.startsWith('..') ? root : shown || '.'}`));
}

async function cmd_test(a: Args) {
	if (a.scriptc) {
		const root = project_root(resolve(a.entry), a.root);
		const out = join(root, '.cui-svelte', 'scriptc', 'bin', app_name(resolve(a.entry)) + '_test');
		const child = launch(await build_with_scriptc({ ...a, out }, false), { CUISV_HEADLESS: '1' }, a.rest);
		child.on('exit', (code) => process.exit(code ?? 1));
		return;
	}
	const r = await build_once(a, 'test');
	if (!r.ok) process.exit(1);
	const child = launch(r.binary, {}, a.rest);
	child.on('exit', (code) => process.exit(code ?? 1));
}

function cmd_compile(a: Args) {
	const file = resolve(a.entry);
	const source = readFileSync(file, 'utf8');
	const r = compile(source, { filename: file, key: relative(dirname(file), file) });
	console.log('/* ---- C ---- */\n' + r.c);
	console.log('/* ---- skeleton ---- */\n' + r.skeleton);
	console.log('/* ---- JS ---- */\n' + r.js);
	for (const w of r.warnings) console.error(yellow('warning ') + w.message);
}

const a = parse_args(process.argv.slice(2));
if (a.cmd === 'create') {
	if (!a.entry) {
		console.error('cui-svelte create: which folder?');
		process.exit(1);
	}
	const dir = create(a.entry);
	console.error(`created ${relative(process.cwd(), dir) || '.'}\n  cd ${relative(process.cwd(), dir) || '.'}\n  npm install\n  npm run dev`);
	process.exit(0);
}
if (!a.entry && a.cmd !== 'help') {
	console.error(`cui-svelte ${a.cmd}: which entry file?`);
	process.exit(1);
}
switch (a.cmd) {
	case 'build':
		await cmd_build(a);
		break;
	case 'run':
		await cmd_run(a);
		break;
	case 'dev':
		await cmd_dev(a);
		break;
	case 'test':
		await cmd_test(a);
		break;
	case 'compile':
		cmd_compile(a);
		break;
	default:
		console.log(readFileSync(new URL(import.meta.url), 'utf8').split('*/')[0].replace(/^\/\*\*?/, '').replace(/^ \* ?/gm, ''));
}
