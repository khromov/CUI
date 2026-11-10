/**
 * The scriptc build (experimental): instead of embedding QuickJS and the JS bundle, the bundle
 * is compiled to native code by scriptc (https://scriptc.dev) and linked with the C
 * templates, the runtime and CUI through scriptc's FFI. The compiled program owns main();
 * src/scriptc/host.ts is its `__cuisv` bridge and frame loop, runtime/cuisv_sc.c the C side.
 *
 *   .cui-svelte/scriptc/app.mjs      the bundle (svelte's runtime, the skeletons, the app)
 *   .cui-svelte/scriptc/ffi.ts       the FFI declarations it imports
 *   .cui-svelte/scriptc/ffi.json     the manifest: functions, libapp.a, libcui.a
 *   .cui-svelte/scriptc/gen/*.c      the templates, as in the QuickJS build
 */
import * as esbuild from 'esbuild';
import ts from 'typescript';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { PKG_ROOT, SVELTE_DIR, svelte_plugin, type ComponentOutput } from './bundle.ts';
import { CUI_ROOT, cache_root } from './native.ts';
import { native_kind } from '../compiler/native.ts';

const SCRIPTC_DIR = join(PKG_ROOT, 'src', 'scriptc');
/** Runtime sources with no JS engine in them. */
const RUNTIME = ['cuisv.c', 'cuisv_records.c', 'cuisv_services.c', 'cuisv_cui.c', 'cuisv_sc.c'];

export interface ScriptcOptions {
	entry: string;
	root: string;
	/** .cui-svelte/scriptc */
	dir: string;
	out: string;
	dev?: boolean;
	verbose?: boolean;
}

export interface ScriptcResult {
	ok: boolean;
	log: string;
	warnings: string[];
	ms: { bundle: number; c: number; scriptc: number };
}

/** scriptc: CUISV_SCRIPTC, the app's or this package's node_modules, or the PATH. */
function find_scriptc(root: string): string {
	if (process.env.CUISV_SCRIPTC) return process.env.CUISV_SCRIPTC;
	for (let d = root; ; d = dirname(d)) {
		const bin = join(d, 'node_modules', '.bin', 'scriptc');
		if (existsSync(bin)) return bin;
		if (dirname(d) === d) break;
	}
	const own = join(PKG_ROOT, 'node_modules', '.bin', 'scriptc');
	return existsSync(own) ? own : 'scriptc';
}

/**
 * Names the bundle reads as globals that the scriptc host provides instead (src/scriptc/
 * globals.ts): timers are counted so the window wakes up for them, and there is no
 * requestAnimationFrame outside a browser.
 */
const INJECT = join(SCRIPTC_DIR, 'globals.ts');

const unsupported = (name: string) =>
	`export class ${name} { constructor() { throw new Error('${name} is not available in a scriptc build'); } }\n`;
const UNSUPPORTED_URL: Record<string, string> = {
	'url.js': unsupported('SvelteURL') + 'export function get_current_url() { return null; }\n',
	'url-search-params.js': unsupported('SvelteURLSearchParams') + 'export const REPLACE = Symbol();\n'
};

export const GET_PROTOTYPE_OF = `export const cuisv_proxies = new WeakSet();
export const cuisv_arrays = new WeakSet();
export var get_prototype_of = (value) => {
	if (typeof value === 'object' && value !== null) {
		if (cuisv_arrays.has(value)) return Array.prototype;
		if (cuisv_proxies.has(value)) return Object.prototype;
	}
	try {
		return Object.getPrototypeOf(value);
	} catch {
		return null;
	}
};`;

async function bundle_js(opts: ScriptcOptions, components: Map<string, ComponentOutput>, warnings: string[]): Promise<string> {
	const entry = resolve(opts.entry);
	const result = await esbuild.build({
		stdin: {
			contents: `import { start } from 'cui-svelte/scriptc';\nimport ${JSON.stringify(entry)};\nstart();\n`,
			resolveDir: dirname(entry),
			sourcefile: 'cui-svelte-entry.js',
			loader: 'js'
		},
		bundle: true,
		write: false,
		format: 'esm',
		platform: 'neutral',
		target: 'es2023',
		mainFields: ['svelte', 'module', 'main'],
		conditions: ['svelte', 'custom-renderer', 'browser', opts.dev ? 'development' : 'production'],
		define: {
			'process.env.NODE_ENV': JSON.stringify(opts.dev ? 'development' : 'production'),
			// answers true for $state arrays too (src/scriptc/svelte-proxy.js)
			'Array.isArray': '__cuisv_is_array',
			// snapshots $state first: scriptc cannot serialize a Proxy
			'JSON.stringify': '__cuisv_json_stringify'
		},
		inject: [INJECT],
		// Node's own modules are scriptc's to provide
		external: ['node:*'],
		legalComments: 'none',
		logLevel: 'silent',
		plugins: [
			{
				name: 'cui-svelte-scriptc',
				setup(build) {
					build.onResolve({ filter: /^cui-svelte\/scriptc$/ }, () => ({ path: join(SCRIPTC_DIR, 'host.ts') }));
					// the FFI declarations stay a module of their own: scriptc binds `declare function`s
					build.onResolve({ filter: /^cuisv-ffi$/ }, () => ({ path: './ffi.ts', external: true }));
					// the app's <script lang="c"> exports, written per build (app_natives below)
					build.onResolve({ filter: /^cuisv-app-natives$/ }, () => ({ path: './natives.ts', external: true }));
					// svelte's proxy.js by a name globals.ts can import (it is not an export of the package)
					build.onResolve({ filter: /^cuisv-svelte-proxy$/ }, () => ({ path: join(SVELTE_DIR, 'src', 'internal', 'client', 'proxy.js') }));
					// npm packages the app imports stay imports: scriptc compiles packages itself, with
					// their types, and esbuild's CommonJS wrappers are the kind of code it fails on.
					// (svelte and what svelte imports are bundled: they need this build's rewrites.)
					build.onResolve({ filter: /^[^./]/ }, (args) => {
						if (/^(svelte|cui-svelte|cuisv-|node:)/.test(args.path) || /^[A-Za-z]:[\\/]/.test(args.path)) return undefined;
						const from_app = args.importer && !/[\\/]node_modules[\\/]/.test(args.importer) && !args.importer.startsWith(join(PKG_ROOT, 'src'));
						return from_app ? { path: args.path, external: true } : undefined;
					});
					// `await import('./x.ts')`: esbuild bundles a dynamically imported module as a lazy
					// wrapper, which scriptc 0.4.10 fails on (an empty SC3004). The module is in the
					// binary either way, so the import becomes a static one, already resolved.
					build.onLoad({ filter: /\.(ts|js|mjs)$/ }, (args) => {
						if (/[\\/]node_modules[\\/]/.test(args.path) || /\.svelte\.(ts|js)$/.test(args.path)) return undefined;
						const source = readFileSync(args.path, 'utf8');
						if (!/\bimport\(/.test(source)) return undefined;
						const imports: string[] = [];
						const contents = source.replace(/\bimport\(\s*(['"])([^'"\n]+)\1\s*\)/g, (_m, _q, spec: string) => {
							imports.push(`import * as __cuisv_dyn_${imports.length} from ${JSON.stringify(spec)};`);
							return `Promise.resolve(__cuisv_dyn_${imports.length - 1})`;
						});
						return { contents: imports.join(' ') + contents, loader: args.path.endsWith('.ts') ? 'ts' : 'js' };
					});
					// scriptc cannot Proxy an array: $state arrays get a stand-in (see the file)
					build.onLoad({ filter: /[\\/]svelte[\\/]src[\\/]internal[\\/]client[\\/]proxy\.js$/ }, () => ({
						contents: readFileSync(join(SCRIPTC_DIR, 'svelte-proxy.js'), 'utf8'),
						loader: 'js'
					}));
					// Object.getPrototypeOf throws in scriptc for a Proxy and for some native values (a
					// Promise). Svelte asks through this one export, which here answers for the proxies
					// of svelte-proxy.js from the sets they are kept in, and null for what throws.
					build.onLoad({ filter: /[\\/]svelte[\\/]src[\\/]internal[\\/]shared[\\/]utils\.js$/ }, (args) => {
						const source = readFileSync(args.path, 'utf8');
						const line = 'export var get_prototype_of = Object.getPrototypeOf;';
						if (!source.includes(line)) return { errors: [{ text: 'svelte changed shared/utils.js: the scriptc build replaces get_prototype_of there' }] };
						return { contents: source.replace(line, GET_PROTOTYPE_OF), loader: 'js' };
					});
					// SvelteURL and SvelteURLSearchParams override members of scriptc's URL classes in
					// ways its checker refuses, and a class with fields is never tree-shaken
					build.onLoad({ filter: /[\\/]svelte[\\/]src[\\/]reactivity[\\/]url(-search-params)?\.js$/ }, (args) => ({
						contents: UNSUPPORTED_URL[basename(args.path)],
						loader: 'js'
					}));
				}
			},
			svelte_plugin({ entry, root: opts.root, dev: !!opts.dev }, components, warnings)
		]
	});
	for (const w of result.warnings) warnings.push(w.text);
	return for_scriptc(result.outputFiles[0].text);
}

/**
 * Rewrites the bundle into what scriptc compiles as untyped JavaScript:
 * - comments go: scriptc type-checks JavaScript by its JSDoc, and svelte's JSDoc both fails
 *   that check and claims types its values do not have, which compiled code would trust;
 * - `let x = void 0` becomes `let x`: the first is typed `undefined` for good, the second
 *   takes the type of what is assigned later;
 * - a class field `x = null` becomes a bare field that the constructor sets to null: with the
 *   initializer the field is typed `null` and a later write of anything else throws;
 * - an object literal `{ a: x, b }` becomes `__cuisv_obj('a', x, 'b', b)`, an object built key
 *   by key. A literal is a record with a fixed layout to scriptc, and storing an existing
 *   object in a record of another layout stores a copy, silently: svelte's `{ effect, … }`
 *   then held a copy of the effect, and removing the first row of an {#each} updated one and
 *   not the other. An object built by key holds what it is given.
 */
export function for_scriptc(js: string): string {
	const is_undefined = (e: ts.Expression): boolean => {
		while (ts.isParenthesizedExpression(e)) e = e.expression;   // what a JSDoc cast leaves
		return ts.isVoidExpression(e) || (ts.isIdentifier(e) && e.text === 'undefined');
	};
	let dynamic_objects = true;
	const drop_undefined: ts.TransformerFactory<ts.SourceFile> = (context) => {
		const visit = (node: ts.Node): ts.Node => {
			if (
				ts.isVariableDeclaration(node) &&
				ts.isIdentifier(node.name) &&
				node.initializer &&
				ts.isVariableDeclarationList(node.parent) &&
				!(node.parent.flags & ts.NodeFlags.Const) &&
				is_undefined(node.initializer)
			) {
				return context.factory.updateVariableDeclaration(node, node.name, undefined, undefined, undefined);
			}
			if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
				const moved = untyped_fields(node, context.factory);
				if (moved) return ts.visitEachChild(moved, visit, context);
			}
			if (dynamic_objects && ts.isObjectLiteralExpression(node) && is_plain_data(node)) {
				const visited = ts.visitEachChild(node, visit, context);
				return dynamic_object(visited, context.factory);
			}
			return ts.visitEachChild(node, visit, context);
		};
		// esbuild names each module in a comment above its code. Object literals are rewritten in
		// the app and in svelte, which run as untyped code that keeps objects by identity, and
		// not in other packages (culori): their own typed records would no longer check.
		return (file) => {
			const statements = file.statements.map((st) => {
				for (const c of ts.getLeadingCommentRanges(js, st.getFullStart()) ?? []) {
					const text = js.slice(c.pos, c.end);
					if (/^\/\/ \S+\.(js|ts|mjs|cjs|svelte)$/.test(text)) dynamic_objects = !/(^|[\\/])node_modules[\\/](?!svelte[\\/])/.test(text.slice(3));
				}
				return ts.visitNode(st, visit) as ts.Statement;
			});
			return context.factory.updateSourceFile(file, statements);
		};
	};
	const out = ts.transpileModule(js, {
		fileName: 'app.mjs',
		compilerOptions: { removeComments: true, target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
		transformers: { before: [drop_undefined] }
	}).outputText;
	return out + DYNAMIC_OBJECT;
}

/** A hoisted function declaration, so it may come last in the module. */
const DYNAMIC_OBJECT = `function __cuisv_obj(...kv) {
    const o = {};
    for (let i = 0; i < kv.length; i += 2) o[kv[i]] = kv[i + 1];
    return o;
}
`;

/**
 * An object literal of data: `key: value`, shorthand and spread members with literal keys.
 * Not one with methods, accessors or computed keys (a Proxy's handler, a renderer's
 * functions), not a destructuring target, and not where the language or a built-in reads a
 * literal: a property descriptor, the handler of a Proxy.
 */
function is_plain_data(node: ts.ObjectLiteralExpression): boolean {
	if (!node.properties.length) return false;
	for (const p of node.properties) {
		if (ts.isSpreadAssignment(p) || ts.isShorthandPropertyAssignment(p)) {
			if (ts.isShorthandPropertyAssignment(p) && p.objectAssignmentInitializer) return false;   // `{ a = 1 } = x`
			continue;
		}
		if (!ts.isPropertyAssignment(p)) return false;
		if (!(ts.isIdentifier(p.name) || ts.isStringLiteral(p.name) || ts.isNumericLiteral(p.name))) return false;
		if (p.name.text === '__proto__') return false;
	}
	// Only a literal that may hold an existing object needs this. One of constants, functions
	// and new values stays a literal, which is what built-ins want for their options
	// (`mkdirSync(path, { recursive: true })` has no lowering for any other object).
	if (node.properties.every((p) => ts.isPropertyAssignment(p) && is_new_value(p.initializer))) return false;
	// a destructuring assignment: `({ a, b } = x)`, `for ({ a } of list)`, also nested in one
	let child: ts.Node = node;
	for (let parent = node.parent; parent; child = parent, parent = parent.parent) {
		if (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken && parent.left === child) return false;
		if ((ts.isForOfStatement(parent) || ts.isForInStatement(parent)) && parent.initializer === child) return false;
		const still_a_pattern =
			ts.isParenthesizedExpression(parent) || ts.isArrayLiteralExpression(parent) || ts.isObjectLiteralExpression(parent) ||
			ts.isPropertyAssignment(parent) || ts.isShorthandPropertyAssignment(parent) || ts.isSpreadElement(parent) || ts.isSpreadAssignment(parent);
		if (!still_a_pattern) break;
	}
	const call = node.parent;
	if ((ts.isCallExpression(call) || ts.isNewExpression(call)) && call.arguments?.includes(node)) {
		const callee = call.expression.getText();
		if (/^(Object\.(defineProperty|defineProperties|create)|Reflect\.defineProperty|Proxy|__defProp)$/.test(callee)) return false;
	}
	return true;
}

/** A constant, a function or an object made right here: nothing else refers to it yet. */
function is_new_value(e: ts.Expression): boolean {
	while (ts.isParenthesizedExpression(e)) e = e.expression;
	if (ts.isPrefixUnaryExpression(e)) return is_new_value(e.operand);
	return (
		ts.isLiteralExpression(e) || ts.isVoidExpression(e) || ts.isTypeOfExpression(e) || ts.isArrowFunction(e) || ts.isFunctionExpression(e) ||
		ts.isNewExpression(e) || ts.isObjectLiteralExpression(e) || ts.isArrayLiteralExpression(e) ||
		e.kind === ts.SyntaxKind.TrueKeyword || e.kind === ts.SyntaxKind.FalseKeyword || e.kind === ts.SyntaxKind.NullKeyword ||
		(ts.isIdentifier(e) && e.text === 'undefined')
	);
}

/** `{ a: x, ...rest, b }` as `Object.assign(__cuisv_obj('a', x), rest, __cuisv_obj('b', b))`. */
function dynamic_object(node: ts.ObjectLiteralExpression, f: ts.NodeFactory): ts.Expression {
	const make = (kv: ts.Expression[]) => f.createCallExpression(f.createIdentifier('__cuisv_obj'), undefined, kv);
	const parts: ts.Expression[] = [];
	let kv: ts.Expression[] = [];
	for (const p of node.properties) {
		if (ts.isSpreadAssignment(p)) {
			parts.push(make(kv), p.expression);
			kv = [];
		} else if (ts.isShorthandPropertyAssignment(p)) {
			kv.push(f.createStringLiteral(p.name.text), f.createIdentifier(p.name.text));
		} else if (ts.isPropertyAssignment(p)) {
			kv.push(f.createStringLiteral((p.name as ts.Identifier | ts.StringLiteral | ts.NumericLiteral).text), p.initializer);
		}
	}
	if (!parts.length) return make(kv);
	if (kv.length) parts.push(make(kv));
	return f.createCallExpression(f.createPropertyAccessExpression(f.createIdentifier('Object'), 'assign'), undefined, parts);
}

/**
 * `#x = null` (or undefined) on an instance becomes `#x;` plus `this.#x = null` at the start
 * of the constructor (after super()), which is added when the class has none.
 */
function untyped_fields<T extends ts.ClassDeclaration | ts.ClassExpression>(node: T, f: ts.NodeFactory): T | null {
	const nullish = (e: ts.Expression): boolean => {
		while (ts.isParenthesizedExpression(e)) e = e.expression;
		return e.kind === ts.SyntaxKind.NullKeyword || ts.isVoidExpression(e) || (ts.isIdentifier(e) && e.text === 'undefined');
	};
	const is_static = (m: ts.PropertyDeclaration) => !!m.modifiers?.some((x) => x.kind === ts.SyntaxKind.StaticKeyword);
	const fields = node.members.filter(
		(m): m is ts.PropertyDeclaration =>
			ts.isPropertyDeclaration(m) && !is_static(m) && !!m.initializer && nullish(m.initializer) && (ts.isPrivateIdentifier(m.name) || ts.isIdentifier(m.name))
	);
	if (!fields.length) return null;
	const assigns = fields.map((m) =>
		f.createExpressionStatement(f.createAssignment(f.createPropertyAccessExpression(f.createThis(), m.name as ts.MemberName), m.initializer!))
	);
	const derived = !!node.heritageClauses?.some((h) => h.token === ts.SyntaxKind.ExtendsKeyword);
	const is_super_call = (st: ts.Statement) => ts.isExpressionStatement(st) && ts.isCallExpression(st.expression) && st.expression.expression.kind === ts.SyntaxKind.SuperKeyword;
	let has_ctor = false;
	let members = node.members.map((m): ts.ClassElement => {
		if (fields.includes(m as ts.PropertyDeclaration)) {
			const p = m as ts.PropertyDeclaration;
			return f.updatePropertyDeclaration(p, p.modifiers, p.name, undefined, undefined, undefined);
		}
		if (ts.isConstructorDeclaration(m) && m.body) {
			has_ctor = true;
			const st = [...m.body.statements];
			// after super(...), when it is a statement of the body; else first
			const at = derived ? st.findIndex(is_super_call) + 1 : 0;
			st.splice(at, 0, ...assigns);
			return f.updateConstructorDeclaration(m, m.modifiers, m.parameters, f.updateBlock(m.body, st));
		}
		return m;
	});
	if (!has_ctor) {
		const args = f.createIdentifier('args');
		const ctor = derived
			? f.createConstructorDeclaration(
					undefined,
					[f.createParameterDeclaration(undefined, f.createToken(ts.SyntaxKind.DotDotDotToken), args)],
					f.createBlock([f.createExpressionStatement(f.createCallExpression(f.createSuper(), undefined, [f.createSpreadElement(args)])), ...assigns], true)
				)
			: f.createConstructorDeclaration(undefined, [], f.createBlock(assigns, true));
		members = [...members, ctor];
	}
	return (
		ts.isClassDeclaration(node)
			? f.updateClassDeclaration(node, node.modifiers, node.name, node.typeParameters, node.heritageClauses, members)
			: f.updateClassExpression(node, node.modifiers, node.name, node.typeParameters, node.heritageClauses, members)
	) as T;
}

/**
 * The functions exported by <script lang="c"> blocks, for scriptc: natives.ts declares each
 * `cuisvn_<name>` (the C shim the compiler emits under CUISV_SCRIPTC) and exports
 * `call_native(name, args)` over them; the manifest entries describe the same signatures.
 */
function app_natives(components: ComponentOutput[]): { ts: string; functions: unknown[] } {
	const functions: unknown[] = [];
	const decls: string[] = [];
	const cases: string[] = [];
	const names: string[] = [];
	for (const f of components.flatMap((c) => c.result.native_exports)) {
		const ret = native_kind(f.ret);
		const params: unknown[] = [];
		const types: string[] = [];
		const args: string[] = [];
		f.params.forEach((p, i) => {
			const k = native_kind(p.type);
			params.push(k === 'num' ? 'f64' : k === 'int' ? 'i32' : k === 'bool' ? 'bool' : 'string');
			types.push(`a${i}: ${k === 'bool' ? 'boolean' : k === 'str' ? 'string' : 'number'}`);
			// as the QuickJS wrappers convert: a missing argument is 0, false or "", and one that
			// does not convert (a Symbol, a valueOf that throws) makes the call throw
			args.push(k === 'bool' ? `!!a${i}` : k === 'str' ? `text(a${i})` : `a${i} === undefined ? 0 : Number(a${i})`);
		});
		if (ret === 'str') {
			params.push({ callback: { id: 'result', params: ['string', { context: 'result' }], returns: 'void', lifetime: 'call' } }, { context: 'result' });
			types.push('result: (s: string) => void');
		}
		functions.push({ name: `cuisvn_${f.name}`, symbol: `cuisvn_${f.name}`, params, returns: ret === 'void' || ret === 'str' ? 'void' : ret === 'bool' ? 'bool' : 'f64' });
		decls.push(`declare function cuisvn_${f.name}(${types.join(', ')}): ${ret === 'void' || ret === 'str' ? 'void' : ret === 'bool' ? 'boolean' : 'number'};`);
		const call = `cuisvn_${f.name}(${args.join(', ')}`;
		cases.push(
			ret === 'str'
				? `\t\tcase ${JSON.stringify(f.name)}: {\n\t\t\tlet out: string | null = null;\n\t\t\t${call}${args.length ? ', ' : ''}(s: string) => {\n\t\t\t\tout = s;\n\t\t\t});\n\t\t\treturn out;\n\t\t}`
				: ret === 'void'
					? `\t\tcase ${JSON.stringify(f.name)}:\n\t\t\t${call});\n\t\t\treturn undefined;`
					: `\t\tcase ${JSON.stringify(f.name)}:\n\t\t\treturn ${call});`
		);
		names.push(f.name);
	}
	// one function with one signature: a table of functions of different signatures, called
	// by name, is what scriptc cannot compile
	const params = Array.from({ length: Math.max(0, ...components.flatMap((c) => c.result.native_exports.map((f) => f.params.length))) }, (_, i) => `a${i}: unknown`);
	const ts_source = [
		'/* Generated by cui-svelte: the functions <script lang="c"> blocks export. Do not edit. */',
		...decls,
		'function text(v: unknown): string {',
		"\tif (typeof v === 'symbol') throw new TypeError('Cannot convert a Symbol value to a string');",
		"\treturn v === undefined ? '' : String(v);",
		'}',
		`export const native_names: string[] = ${JSON.stringify(names)};`,
		`export function call_native(name: string, args: unknown[]): unknown {`,
		...params.map((p, i) => `\tconst ${p} = args[${i}];`),
		'\tswitch (name) {',
		...cases,
		'\t}',
		'\tthrow new Error(`cui-svelte: no native function ${name}`);',
		'}',
		''
	].join('\n');
	return { ts: ts_source, functions };
}

function registry_c(components: ComponentOutput[]): string {
	const symbols = components.flatMap((c) => c.result.templates.map((t) => t.symbol));
	return [
		'/* Generated by cui-svelte: every template of the app. Do not edit. */',
		'#include "cuisv.h"',
		...symbols.map((s) => `extern const cuisv_template ${s};`),
		`const cuisv_template *const cuisv_templates[] = { ${symbols.map((s) => '&' + s).join(', ') || 'NULL'} };`,
		`const int cuisv_template_count = ${symbols.length};`,
		// <script lang="c"> exports are bound through the FFI (app_natives), not through tables
		'const cuisv_native *const cuisv_native_tables[] = { NULL };',
		'const int *const cuisv_native_table_counts[] = { NULL };',
		'const int cuisv_native_table_count = 0;',
		''
	].join('\n');
}

function run(cmd: string, args: string[], cwd: string, verbose?: boolean): { ok: boolean; log: string } {
	const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', stdio: verbose ? 'inherit' : 'pipe' });
	return { ok: r.status === 0, log: `${r.stdout ?? ''}${r.stderr ?? ''}${r.error ? String(r.error) : ''}` };
}

/** libcui.a from the shared CMake tree the QuickJS builds use (a normal build makes it). */
function find_libcui(): string | null {
	for (const mode of ['release', 'debug']) {
		const lib = join(cache_root(), mode, 'build', 'cui', 'libcui.a');
		if (existsSync(lib)) return lib;
	}
	return null;
}

export async function build_scriptc(opts: ScriptcOptions): Promise<ScriptcResult> {
	const ms = { bundle: 0, c: 0, scriptc: 0 };
	const warnings: string[] = [];
	const fail = (log: string): ScriptcResult => ({ ok: false, log, warnings, ms });
	mkdirSync(join(opts.dir, 'gen'), { recursive: true });
	mkdirSync(join(opts.dir, 'obj'), { recursive: true });

	let t = performance.now();
	const components = new Map<string, ComponentOutput>();
	let js: string;
	try {
		js = await bundle_js(opts, components, warnings);
	} catch (e) {
		const err = e as { errors?: esbuild.Message[]; message: string };
		return fail(err.errors?.length ? err.errors.map((m) => `${m.location ? `${m.location.file}:${m.location.line}: ` : ''}${m.text}`).join('\n') : err.message);
	}
	const sorted = [...components.values()].sort((a, b) => a.key.localeCompare(b.key));
	const natives = app_natives(sorted);
	writeFileSync(join(opts.dir, 'app.mjs'), js);
	writeFileSync(join(opts.dir, 'natives.ts'), natives.ts);
	copyFileSync(join(SCRIPTC_DIR, 'ffi.ts'), join(opts.dir, 'ffi.ts'));
	ms.bundle = performance.now() - t;

	// ---- C: templates + the runtime, into one archive ----
	t = performance.now();
	const libcui = find_libcui();
	if (!libcui) return fail('the scriptc build links the libcui.a of a normal build: run `cui-svelte build` once first');
	const sources: string[] = RUNTIME.map((f) => join(PKG_ROOT, 'runtime', f));
	for (const c of sorted) {
		const file = join(opts.dir, 'gen', 'c_' + c.key.replace(/[^A-Za-z0-9]+/g, '_') + '.c');
		writeFileSync(file, c.result.c);
		sources.push(file);
	}
	writeFileSync(join(opts.dir, 'gen', 'registry.c'), registry_c(sorted));
	sources.push(join(opts.dir, 'gen', 'registry.c'));
	const cc = process.env.CC ?? 'cc';
	const objects: string[] = [];
	for (const src of sources) {
		const obj = join(opts.dir, 'obj', basename(src).replace(/\.c$/, '.o'));
		const r = run(cc, ['-std=c11', opts.dev ? '-O0' : '-O2', '-g', '-DCUISV_SCRIPTC', '-c', src, '-o', obj, `-I${join(PKG_ROOT, 'runtime')}`, `-I${join(CUI_ROOT, 'include')}`, `-I${join(CUI_ROOT, 'src')}`], opts.dir);
		if (!r.ok) return fail(r.log);
		objects.push(obj);
	}
	const lib = join(opts.dir, 'libapp.a');
	const ar = run('ar', ['rcs', lib, ...objects], opts.dir);
	if (!ar.ok) return fail(ar.log);
	ms.c = performance.now() - t;

	// ---- scriptc: the bundle to native code, linked with the archives ----
	t = performance.now();
	const manifest = {
		ffi_format: 7,
		functions: [...JSON.parse(readFileSync(join(SCRIPTC_DIR, 'ffi.functions.json'), 'utf8')), ...natives.functions],
		libraries: [lib, libcui],
		system_libraries: process.platform === 'linux' ? ['m', 'X11', 'dl', 'pthread'] : [],
		...(process.platform === 'darwin' ? { frameworks: ['Cocoa', 'QuartzCore', 'OpenGL'] } : {})
	};
	writeFileSync(join(opts.dir, 'ffi.json'), JSON.stringify(manifest, null, '\t'));
	mkdirSync(dirname(opts.out), { recursive: true });
	const r = run(find_scriptc(opts.root), ['build', 'app.mjs', '--ffi', 'ffi.json', '--print=diagnostics', '--no-keep-llvm', '-o', resolve(opts.out), ...(opts.dev ? ['--optimization', 'dev'] : [])], opts.dir);
	ms.scriptc = performance.now() - t;
	const d = read_diagnostics(r.log, opts.dir);
	if (!d) return { ok: r.ok, log: r.log, warnings, ms };
	warnings.push(...d.warnings);
	return { ok: r.ok && d.ok, log: d.errors.join('\n'), warnings, ms };
}

interface Diagnostic {
	code: string;
	severity: string;
	message: string;
	hint?: string;
	count: number;
	sites: { file: string; line: number }[];
}

/**
 * scriptc's report (--print=diagnostics), one line per cause. Worth reading on every build:
 * JavaScript that scriptc cannot compile is a warning, not an error, and that statement
 * throws when it runs. SC6101 (untyped code is slower) is left out: it names most of svelte.
 */
function read_diagnostics(out: string, dir: string): { ok: boolean; warnings: string[]; errors: string[] } | null {
	const start = out.indexOf('{');
	let report: { success: boolean; groups: Diagnostic[] };
	try {
		report = JSON.parse(out.slice(start, out.lastIndexOf('}') + 1));
	} catch {
		return null;
	}
	const line = (g: Diagnostic) => {
		const sites = g.sites.slice(0, 3).map((s) => `${relative(dir, s.file)}:${s.line}`);
		const more = g.count > sites.length ? ` (+${g.count - sites.length} more)` : '';
		return `scriptc ${g.code}: ${g.message.split('\n')[0] || 'internal error (no message)'}\n    at ${sites.join(', ')}${more}`;
	};
	const groups = report.groups.filter((g) => g.code !== 'SC6101');
	// SC8001: a package scriptc cannot compile would run in Node.js inside the app (a "Node
	// island"), which needs a libnode beside the binary: for an app without an engine, an error.
	// SC6007 only describes values that come out of such an island.
	const island = groups.some((g) => g.code === 'SC8001');
	const fatal = (g: Diagnostic) => g.severity === 'error' || g.code === 'SC8001';
	return {
		ok: report.success && !island,
		warnings: groups.filter((g) => !fatal(g) && g.code !== 'SC6007').map(line),
		errors: groups.filter(fatal).map((g) => line(g) + (g.code === 'SC8001' ? '\n    scriptc cannot compile this package to native code, so the scriptc build cannot use it' : ''))
	};

}
