/**
 * .svelte -> { C, JS }.
 *
 * The markup becomes C render functions (template.ts); the script, plus a skeleton of the
 * markup that keeps only blocks and dynamic values, is compiled by Svelte itself with the
 * cui-svelte renderer, so runes, blocks, snippets and components behave exactly as Svelte's.
 */
import { compile as svelte_compile, parse } from 'svelte/compiler';
import type { AST } from 'svelte/compiler';
import { SPECS } from './specs.ts';
import { new_template, walk, reset_statics, STATICS, type CompileContext, type Template, type Warning } from './template.ts';
import { create_style_resolver, type GlobalRules } from './styles.ts';
import { Records } from './records.ts';
import { extract_c, native_wrappers, type CBlocks } from './native.ts';

export type { Warning } from './template.ts';

export interface CompileOptions {
	filename: string;
	/** Stable identity for template ids, normally the path relative to the project root. */
	key: string;
	dev?: boolean;
	/** Module the skeleton imports its renderer from. */
	renderer?: string;
	/** :global rules from every component of the app (collect_globals). */
	globals?: GlobalRules;
	/** C from the component's sibling file (Meter.svelte.c), added like a <script lang="c">. */
	c_source?: string;
}

export interface TemplateInfo {
	id: number;
	symbol: string;
	name: string;
	slots: number;
	sites: number;
}

export interface CompileResult {
	js: string;
	c: string;
	skeleton: string;
	templates: TemplateInfo[];
	warnings: Warning[];
	/** The table of C functions exported to JS by <script lang="c">, if any. */
	natives: string | null;
}

/** Local names that refer to cui-svelte components: `import { Button as B } from 'cui-svelte'`. */
function intrinsic_imports(ast: AST.Root): Map<string, string> {
	const out = new Map<string, string>();
	for (const script of [ast.module, ast.instance]) {
		if (!script) continue;
		for (const stmt of (script.content as unknown as { body: { type: string; source?: { value: string }; specifiers?: { type: string; imported?: { name?: string; value?: string }; local: { name: string } }[] }[] }).body) {
			if (stmt.type !== 'ImportDeclaration') continue;
			const from = stmt.source?.value;
			if (from !== 'cui-svelte' && from !== 'cui-svelte/components') continue;
			for (const s of stmt.specifiers ?? []) {
				if (s.type === 'ImportSpecifier') {
					const name = s.imported?.name ?? s.imported?.value ?? s.local.name;
					if (SPECS.has(name)) out.set(s.local.name, name);
				} else if (s.type === 'ImportNamespaceSpecifier') {
					for (const name of SPECS.keys()) out.set(`${s.local.name}.${name}`, name);
				}
			}
		}
	}
	return out;
}

function script_block(source: string, script: AST.Script, inject: string): string {
	const open_end = source.indexOf('>', script.start) + 1;
	const close = source.lastIndexOf('</script', script.end);
	const open = source.slice(script.start, open_end);
	return `${open}${inject}${source.slice(open_end, close)}</script>`;
}

const HELPERS = "import * as __cuisv_h from 'cui-svelte/helpers';";

export function compile(original: string, options: CompileOptions): CompileResult {
	const cblocks = extract_c(original, options.c_source);
	const source = cblocks.source;
	const ast = parse(source, { modern: true, filename: options.filename });
	const warnings: Warning[] = [];
	const ctx: CompileContext = {
		source,
		filename: options.filename,
		key: options.key,
		intrinsics: intrinsic_imports(ast),
		styles: create_style_resolver(ast, options.globals, warnings),
		warnings,
		templates: [],
		ancestors: [],
		records: new Records(),
		inject: []
	};
	reset_statics();
	const root = new_template(ctx);
	// :root rules (theme variables, the window background) apply while the component shows
	for (const l of ctx.styles.theme()) root.line(l);
	walk(ctx, root, ast.fragment.nodes);
	const statics = [...STATICS];

	// the skeleton: scripts as written (plus the helpers import), then the template tree
	let skeleton = '';
	if (ast.module) skeleton += script_block(source, ast.module, '') + '\n';
	const inject = HELPERS + ctx.inject.join(' ');
	if (ast.instance) skeleton += script_block(source, ast.instance, inject);
	else skeleton += `<script>${inject}</script>`;
	if (ast.options) skeleton += source.slice(ast.options.start, ast.options.end);
	skeleton += '\n' + root.element() + '\n';

	let js: string;
	try {
		const out = svelte_compile(skeleton, {
			filename: options.filename,
			runes: true,
			generate: 'client',
			dev: !!options.dev,
			discloseVersion: false,
			experimental: { customRenderer: options.renderer ?? 'cui-svelte/renderer', async: true } as never,
			warningFilter: (w) => !w.code.startsWith('a11y') && w.code !== 'element_invalid_self_closing_tag'
		});
		js = out.js.code;
		for (const w of out.warnings) warnings.push({ code: w.code, message: w.message });
	} catch (e) {
		const err = e as Error & { frame?: string };
		const where = (e as { start?: { line: number; column: number } }).start;
		throw new Error(
			`${options.filename}${where && where.line <= script_lines(source) ? `:${where.line}:${where.column}` : ''}: ${err.message}` +
				(process.env.CUISV_DEBUG ? `\n--- generated skeleton ---\n${skeleton}` : '\n(CUISV_DEBUG=1 shows the Svelte source cui-svelte generated for it)')
		);
	}

	const natives = cblocks.code ? `cuisv_natives_${hex(ctx.templates[0].id)}` : null;
	return { js, c: emit_c(ctx, options, statics, cblocks, natives), skeleton, templates: ctx.templates.map((t) => info(ctx, t)), warnings, natives };
}

/** Lines up to the end of the instance script, where skeleton and source line numbers agree. */
function script_lines(source: string) {
	const end = source.search(/<\/script>\s*(?![\s\S]*<\/script>)/);
	return end < 0 ? 0 : source.slice(0, end).split('\n').length;
}

function hex(id: number) {
	return id.toString(16).padStart(8, '0');
}

function info(ctx: CompileContext, t: Template): TemplateInfo {
	return { id: t.id, symbol: `cuisv_tpl_${hex(t.id)}`, name: `${ctx.key}#${t.index}`, slots: t.slot_count, sites: t.site_count };
}

function emit_c(ctx: CompileContext, options: CompileOptions, statics: string[], cblocks: CBlocks, natives: string | null): string {
	const out: string[] = [];
	out.push(`/* Generated by cui-svelte from ${options.key}. Do not edit. */`);
	out.push('#include "cuisv.h"');
	out.push('#include <stddef.h>');
	out.push('#include <stdio.h>');
	out.push('#include <string.h>');
	out.push('');
	if (cblocks.code && natives) {
		out.push('#ifndef CUISV_WEB', '#include "quickjs.h"', '#endif', '#define cuisv_export', '', '/* ---- <script lang="c"> ---- */', cblocks.code, '/* ---- end ---- */', '');
		const w = native_wrappers(cblocks.exports, natives);
		for (const e of w.errors) ctx.warnings.push({ code: 'native_export', message: e });
		out.push(w.c, '');
	}
	const pre = ctx.records.preamble();
	if (pre) out.push(pre, '');
	if (statics.length) out.push(...statics, '');
	for (const t of ctx.templates) out.push(`static void cuisv_t_${hex(t.id)}(cui_ctx *ui, cuisv_scope *s);`);
	out.push('');
	for (const t of ctx.templates) {
		const i = info(ctx, t);
		out.push(`const cuisv_template ${i.symbol} = { 0x${hex(t.id)}u, "${i.name}", cuisv_t_${hex(t.id)}, ${t.slot_count}, ${t.site_count} };`);
	}
	for (const t of ctx.templates) {
		out.push('');
		out.push(`static void cuisv_t_${hex(t.id)}(cui_ctx *ui, cuisv_scope *s) {`);
		out.push('    (void)ui; (void)s;');
		out.push(...t.lines);
		out.push('}');
	}
	return out.join('\n') + '\n';
}
