/**
 * Bundles an app for QuickJS with esbuild: every .svelte file goes through the cui-svelte
 * compiler, whose C halves are collected on the side; svelte and cui-svelte always resolve
 * to this package's own copies (svelte is the vendored custom renderer build).
 */
import * as esbuild from 'esbuild';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileModule } from 'svelte/compiler';
import { compile, type CompileResult, type Warning } from '../compiler/index.ts';
import { collect_globals, type GlobalRules } from '../compiler/styles.ts';

export const PKG_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SVELTE_DIR = dirname(fileURLToPath(import.meta.resolve('svelte/package.json')));

const SUBPATHS: Record<string, string> = {
	'cui-svelte': 'src/runtime/index.ts',
	'cui-svelte/renderer': 'src/runtime/renderer.ts',
	'cui-svelte/helpers': 'src/runtime/helpers.ts',
	'cui-svelte/globals': 'src/runtime/globals.ts',
	'cui-svelte/components': 'src/runtime/components.ts',
	'cui-svelte/test': 'src/runtime/test.ts',
	'cui-svelte/web': 'src/web/boot.ts'
};

export interface ComponentOutput {
	file: string;
	key: string;
	result: CompileResult;
}

export interface BundleResult {
	js: string;
	components: Map<string, ComponentOutput>;
	warnings: string[];
	errors: string[];
}

export interface BundleOptions {
	entry: string;
	/** Project root: template ids and messages use paths relative to it. */
	root: string;
	dev: boolean;
	minify?: boolean;
	/** Previous results to reuse when a .svelte file, its .svelte.c and the project's global styles did not change. */
	cache?: Map<string, { source: string; out: ComponentOutput }>;
	/** 'web': for the browser build (boots the wasm module first; no QuickJS globals). */
	target?: 'native' | 'web';
}

function format_warning(file: string, source: string, w: Warning) {
	let where = file;
	if (w.start !== undefined) {
		const before = source.slice(0, w.start);
		const line = before.split('\n').length;
		const col = w.start - before.lastIndexOf('\n');
		where += `:${line}:${col}`;
	}
	return `${where}: ${w.message} (${w.code})`;
}

function key_of(root: string, file: string) {
	return relative(root, file).split(sep).join('/');
}

export function svelte_plugin(opts: BundleOptions, components: Map<string, ComponentOutput>, warnings: string[]): esbuild.Plugin {
	return {
		name: 'cui-svelte',
		setup(build) {
			build.onResolve({ filter: /^cui-svelte(\/.*)?$/ }, (args) => {
				const target = SUBPATHS[args.path];
				if (!target) return { errors: [{ text: `cui-svelte has no export ${args.path}` }] };
				return { path: join(PKG_ROOT, target) };
			});
			build.onResolve({ filter: /^svelte(\/.*)?$/ }, async (args) => {
				if (args.pluginData?.cuisv_svelte) return undefined;
				const r = await build.resolve(args.path, {
					kind: args.kind,
					resolveDir: SVELTE_DIR,
					pluginData: { cuisv_svelte: true }
				});
				return r.errors.length ? { errors: r.errors } : { path: r.path, sideEffects: r.sideEffects };
			});
			build.onLoad({ filter: /\.svelte$/ }, (args) => {
				const source = readFileSync(args.path, 'utf8');
				const sibling = existsSync(args.path + '.c') ? readFileSync(args.path + '.c', 'utf8') : undefined;
				const key = key_of(opts.root, args.path);
				const globals = globals_for(opts);
				// what the output depends on: the file, its C, and the project's :global and :root rules
				const inputs = `${globals.hash}\n${source}\n${sibling ?? ''}`;
				const cached = opts.cache?.get(args.path);
				let out: ComponentOutput;
				if (cached && cached.source === inputs) {
					out = cached.out;
				} else {
					const result = compile(source, { filename: args.path, key, dev: opts.dev, globals: globals.rules, c_source: sibling });
					out = { file: args.path, key, result };
					opts.cache?.set(args.path, { source: inputs, out });
				}
				for (const w of out.result.warnings) warnings.push(format_warning(key, source, w));
				components.set(args.path, out);
				return { contents: out.result.js, loader: 'js', resolveDir: dirname(args.path) };
			});
			build.onLoad({ filter: /\.svelte\.(js|ts)$/ }, async (args) => {
				let source = readFileSync(args.path, 'utf8');
				if (args.path.endsWith('.ts')) source = (await esbuild.transform(source, { loader: 'ts', format: 'esm', target: 'es2023' })).code;
				const out = compileModule(source, { filename: args.path, dev: opts.dev, generate: 'client' });
				return { contents: out.js.code, loader: 'js', resolveDir: dirname(args.path) };
			});
		}
	};
}

interface Globals {
	rules: GlobalRules;
	/** Of the rules' content: a component compiled with other globals is compiled again. */
	hash: string;
}

let globals_cache: { root: string; value: Globals } | null = null;
function globals_for(opts: BundleOptions): Globals {
	if (globals_cache?.root !== opts.root) {
		const rules = collect_globals(opts.root);
		// `order` counts every rule ever parsed, so it differs between two collections of the same rules
		const hash = createHash('sha1')
			.update(JSON.stringify(rules.map(({ order: _, ...rule }) => rule)))
			.digest('hex');
		globals_cache = { root: opts.root, value: { rules, hash } };
	}
	return globals_cache.value;
}

export function reset_globals() {
	globals_cache = null;
}

export async function bundle(opts: BundleOptions): Promise<BundleResult> {
	const components = new Map<string, ComponentOutput>();
	const warnings: string[] = [];
	const entry = resolve(opts.entry);
	try {
		const result = await esbuild.build({
			stdin: {
				contents:
					opts.target === 'web'
						? `import { boot } from 'cui-svelte/web';\nawait boot({ wasm: new URL('./app.wasm', import.meta.url) });\nawait import(${JSON.stringify(entry)});\n`
						: `import 'cui-svelte/globals';\nimport ${JSON.stringify(entry)};\n`,
				resolveDir: dirname(entry),
				sourcefile: 'cui-svelte-entry.js',
				loader: 'js'
			},
			bundle: true,
			write: false,
			format: 'esm',
			platform: opts.target === 'web' ? 'browser' : 'neutral',
			target: 'es2023',
			mainFields: ['svelte', 'module', 'main'],
			conditions: ['svelte', 'custom-renderer', 'browser', opts.dev ? 'development' : 'production'],
			define: { 'process.env.NODE_ENV': JSON.stringify(opts.dev ? 'development' : 'production') },
			minify: !!opts.minify,
			legalComments: 'none',
			logLevel: 'silent',
			plugins: [svelte_plugin(opts, components, warnings)]
		});
		for (const w of result.warnings) warnings.push(`${w.location ? `${relative(opts.root, w.location.file)}:${w.location.line}: ` : ''}${w.text}${w.location?.lineText ? `\n    ${w.location.lineText.trim()}` : ''}`);
		return { js: result.outputFiles[0].text, components, warnings, errors: [] };
	} catch (e) {
		const err = e as { errors?: esbuild.Message[]; message: string };
		const errors = err.errors?.length
			? err.errors.map((m) => `${m.location ? `${m.location.file}:${m.location.line}:${m.location.column}: ` : ''}${m.text}`)
			: [err.message];
		return { js: '', components, warnings, errors };
	}
}
