/**
 * Template splitting: a component's markup becomes C render functions (one per template:
 * the root, each block branch, each snippet) plus a skeleton, the Svelte source that keeps
 * only the blocks and the dynamic expressions. See ../../ARCHITECTURE.md.
 */
import type { AST } from 'svelte/compiler';
import { SPECS, bind_kind, type ParamSpec, type Spec, type EventSpec } from './specs.ts';
import { SPECIAL } from './special.ts';
import { api, enum_constant, enum_names, icon_constant, is_enum } from './api.ts';
import { parse_color, parse_size, parse_length, type Color } from '../shared/values.ts';
import type { StyleResolver, ElementStyle, ElementInfo } from './styles.ts';
import { bind_pointer } from './styles.ts';
import { apply_fields, text_style, display_none } from './apply.ts';
import { inline_layer } from './inline.ts';
import { HTML, emit_html } from './html.ts';
import { Records } from './records.ts';

export interface Warning {
	code: string;
	message: string;
	start?: number;
	end?: number;
}

type Node = AST.Fragment['nodes'][number];
type AnyNode = Node | AST.Attribute;

export function fnv1a(s: string): number {
	let h = 0x811c9dc5;
	const bytes = new TextEncoder().encode(s);
	for (const b of bytes) {
		h ^= b;
		h = Math.imul(h, 0x01000193) >>> 0;
	}
	return h >>> 0;
}

export function c_string(s: string): string {
	let out = '"';
	for (const b of new TextEncoder().encode(s)) {
		if (b === 0x22) out += '\\"';
		else if (b === 0x5c) out += '\\\\';
		else if (b === 0x0a) out += '\\n';
		else if (b === 0x0d) out += '\\r';
		else if (b === 0x09) out += '\\t';
		else if (b === 0x3f) out += '\\?'; // no trigraphs
		else if (b < 0x20 || b >= 0x7f) out += '\\' + b.toString(8).padStart(3, '0');
		else out += String.fromCharCode(b);
	}
	return out + '"';
}

function c_float(n: number): string {
	if (!Number.isFinite(n)) return '0';
	const s = String(n);
	return /[.e]/.test(s) ? s + 'f' : s + '.0f';
}

export function c_color(c: Color): string {
	if ('token' in c) return `CUI_TOKEN_COLOR(${c.token})`;
	return `((cui_color){ ${c.r}, ${c.g}, ${c.b}, ${c.a} })`;
}

export function c_size(kind: number, value: number): string {
	switch (kind) {
		case 1:
			return `CUI_GROW(${c_float(value)})`;
		case 2:
			return `CUI_PX(${c_float(value)})`;
		case 3:
			return `CUI_PCT(${c_float(value)})`;
		default:
			return 'CUI_FIT';
	}
}

/** A value for C: either known at build time or read from a slot. */
export interface Val {
	/** C expression. */
	c: string;
	dynamic: boolean;
}

/** What markup said for an attribute, before it meets a C type. */
export type Source =
	| { kind: 'static'; value: unknown }
	| { kind: 'expr'; js: string; node?: AnyNode }
	| { kind: 'bind'; js: string; set: string; node?: AnyNode };

export class Template {
	readonly index: number;
	readonly id: number;
	slot_count = 0;
	site_count = 0;
	/** Skeleton attributes, `n3={expr}`. */
	attrs: string[] = [];
	/** Skeleton children of the template element: sites and snippet declarations. */
	children: string[] = [];
	/** {@const} tags, which go right before the template element. */
	consts: string[] = [];
	lines: string[] = [];
	private key_counter = 0;
	private depth = 1;

	constructor(index: number, id: number) {
		this.index = index;
		this.id = id;
	}

	slot(kind: string, js: string | null): number {
		const i = this.slot_count++;
		if (js !== null) this.attrs.push(`${kind}${i}={${js}}`);
		return i;
	}

	private conds = new Map<string, number>();
	/** A boolean slot for a JS condition, shared by everything in this template that asks. */
	cond_slot(js: string): number {
		let i = this.conds.get(js);
		if (i === undefined) {
			i = this.slot('b', js);
			this.conds.set(js, i);
		}
		return i;
	}

	setter(bound: number, js: string): number {
		const i = this.slot_count++;
		this.attrs.push(`g${i}v${bound}={${js}}`);
		return i;
	}

	site(content: string): number {
		const i = this.site_count++;
		this.children.push(`<s${i}>${content}</s${i}>`);
		return i;
	}

	key(): string {
		return `k${this.key_counter++}`;
	}

	line(s: string) {
		this.lines.push('    '.repeat(this.depth) + s);
	}
	open(s: string) {
		this.line(s);
		this.depth++;
	}
	close(s = '}') {
		this.depth--;
		this.line(s);
	}

	element(): string {
		return `${this.consts.join('')}<t${this.id}${this.attrs.length ? ' ' + this.attrs.join(' ') : ''}>${this.children.join('')}</t${this.id}>`;
	}
}

export interface CompileContext {
	source: string;
	filename: string;
	/** Stable name for template ids: the path relative to the project. */
	key: string;
	/** Local names imported from 'cui-svelte' mapped to component names. */
	intrinsics: Map<string, string>;
	styles: StyleResolver;
	warnings: Warning[];
	templates: Template[];
	/** Elements around the one being compiled, outermost first (for CSS combinators). */
	ancestors: ElementInfo[];
	/** Struct descriptors the C file needs. */
	records: Records;
	/** Declarations the skeleton's script needs (state for row windows). */
	inject: string[];
}

export function new_template(ctx: CompileContext): Template {
	const index = ctx.templates.length;
	const t = new Template(index, fnv1a(`${ctx.key}#${index}`));
	ctx.templates.push(t);
	return t;
}

export function warn(ctx: CompileContext, code: string, message: string, node?: { start?: number; end?: number }) {
	ctx.warnings.push({ code, message, start: node?.start, end: node?.end });
}

/** The source text of a node (Svelte's estree expressions carry start/end without typing them). */
export function src(ctx: CompileContext, node: unknown): string {
	const n = node as { start: number; end: number };
	return ctx.source.slice(n.start, n.end);
}

/** JS for what markup gave: the expression, or the literal. */
export function js_of(s: Source): string {
	return s.kind === 'static' ? JSON.stringify(s.value) : s.js;
}

// ---- fragments ------------------------------------------------------------------------------

/** Emits a fragment's nodes into template `t`, inside whatever C container is open. */
/**
 * `text` is a C `const cuisv_text_style *` for text directly in this fragment, or undefined.
 * `inline`: the fragment flows like inline content, so spaces next to elements are kept.
 */
export function walk(ctx: CompileContext, t: Template, nodes: Node[], text?: string, inline = false) {
	let run: Node[] = [];
	const real = nodes.filter((n) => n.type !== 'Comment' && !(n.type === 'Text' && !n.data.trim()));
	const first = real[0];
	const last = real[real.length - 1];
	const flush = () => {
		if (run.length) {
			const at_start = !inline || run.includes(first);
			const at_end = !inline || run.includes(last);
			emit_text_run(ctx, t, run, text, at_start, at_end);
		}
		run = [];
	};
	for (const node of nodes) {
		if (node.type === 'Text' || node.type === 'ExpressionTag') {
			run.push(node);
			continue;
		}
		if (node.type === 'Comment') continue;
		flush();
		emit_node(ctx, t, node);
	}
	flush();
}

function is_blank(nodes: Node[]) {
	return nodes.every((n) => (n.type === 'Text' && !n.data.trim()) || n.type === 'Comment');
}

/** Text and {expressions} in a row become one string, collapsed like HTML whitespace. */
export function text_of(ctx: CompileContext, nodes: Node[], trim_start = true, trim_end = true): Source | null {
	const parts: (string | { js: string })[] = [];
	for (const n of nodes) {
		if (n.type === 'Text') parts.push(n.data);
		else if (n.type === 'ExpressionTag') parts.push({ js: src(ctx, n.expression) });
	}
	// collapse whitespace like HTML does between words
	const collapsed: (string | { js: string })[] = parts.map((p) => (typeof p === 'string' ? p.replace(/\s+/g, ' ') : p));
	if (trim_start && typeof collapsed[0] === 'string') collapsed[0] = collapsed[0].replace(/^\s+/, '');
	const last = collapsed.length - 1;
	if (trim_end && typeof collapsed[last] === 'string') collapsed[last] = (collapsed[last] as string).replace(/\s+$/, '');
	if (collapsed.every((p) => typeof p === 'string' && !p.trim())) return null;
	if (collapsed.every((p) => typeof p === 'string')) {
		const s = collapsed.join('');
		return s ? { kind: 'static', value: s } : null;
	}
	if (collapsed.length === 1 && typeof collapsed[0] !== 'string') {
		return { kind: 'expr', js: `__cuisv_h.t(${collapsed[0].js})` };
	}
	const tl = collapsed
		.map((p) => (typeof p === 'string' ? p.replace(/[`\\]/g, '\\$&').replace(/\$\{/g, '\\${') : `\${__cuisv_h.t(${p.js})}`))
		.join('');
	return { kind: 'expr', js: '`' + tl + '`' };
}

function emit_text_run(ctx: CompileContext, t: Template, run: Node[], text_c?: string, trim_start = true, trim_end = true) {
	if (is_blank(run)) return;
	const text = text_of(ctx, run, trim_start, trim_end);
	if (!text) return;
	const v = string_val(t, text);
	const own = text_c ?? 'NULL';
	t.line(`cuisv_text(ui, ${v.c}, ${own});`);
}

function emit_node(ctx: CompileContext, t: Template, node: Node) {
	switch (node.type) {
		case 'RegularElement': {
			if (!HTML[node.name]) warn(ctx, 'unknown_element', `<${node.name}> is not an HTML element cui-svelte knows; it renders as a <div>`, node);
			return emit_html(ctx, t, node);
		}
		case 'Component': {
			const name = ctx.intrinsics.get(node.name);
			if (name) {
				const spec = SPECS.get(name);
				if (spec) return emit_component(ctx, t, node, spec);
				warn(ctx, 'unknown_component', `cui-svelte has no component ${name}`, node);
				return;
			}
			return emit_user_component(ctx, t, node);
		}
		case 'IfBlock':
			return emit_site(t, if_block(ctx, node));
		case 'EachBlock':
			return emit_site(t, each_block(ctx, node));
		case 'AwaitBlock':
			return emit_site(t, await_block(ctx, node));
		case 'KeyBlock':
			return emit_site(t, `{#key ${src(ctx, node.expression)}}${branch(ctx, node.fragment)}{/key}`);
		case 'SnippetBlock':
			t.children.push(snippet_block(ctx, node));
			return;
		case 'RenderTag':
			return emit_site(t, `{@render ${src(ctx, node.expression)}}`);
		case 'ConstTag':
			t.consts.push(src(ctx, node));
			return;
		case 'DebugTag':
			t.consts.push(src(ctx, node));
			return;
		case 'HtmlTag':
			warn(ctx, 'html_tag', '{@html} has no meaning in CUI and is left out', node);
			return;
		case 'SvelteBoundary': {
			const attrs = node.attributes.map((a) => src(ctx, a)).join(' ');
			return emit_site(t, `<svelte:boundary${attrs ? ' ' + attrs : ''}>${branch(ctx, node.fragment)}</svelte:boundary>`);
		}
		case 'SvelteComponent': {
			return emit_user_component(ctx, t, node as unknown as AST.Component, 'svelte:component');
		}
		case 'SvelteSelf':
			return emit_user_component(ctx, t, node as unknown as AST.Component, 'svelte:self');
		case 'SvelteHead':
		case 'SvelteBody':
		case 'SvelteDocument':
			warn(ctx, 'unsupported_special', `<${(node as { name: string }).name}> has no meaning in CUI and is left out`, node);
			return;
		case 'SvelteWindow':
			warn(ctx, 'unsupported_special', '<svelte:window> is not supported yet; use on_key() from cui-svelte for shortcuts', node);
			return;
		default:
			warn(ctx, 'unsupported_node', `${node.type} is not supported by cui-svelte`, node as never);
	}
}

/** The site an {#each} renders into, for an emitter that draws its scopes itself. */
export function each_site(ctx: CompileContext, t: Template, node: AST.EachBlock): number {
	return t.site(each_block(ctx, node));
}

function emit_site(t: Template, content: string) {
	const site = t.site(content);
	t.line(`cuisv_render_site(ui, s, ${site});`);
}

/** A block branch: a template of its own, rendered in the site. */
function branch(ctx: CompileContext, fragment: AST.Fragment | null | undefined): string {
	if (!fragment || is_blank(fragment.nodes)) {
		// an empty branch still needs its {@const}s evaluated for nothing; leave it empty
		return fragment ? fragment.nodes.filter((n) => n.type === 'ConstTag').map((n) => src(ctx, n)).join('') : '';
	}
	const b = new_template(ctx);
	walk(ctx, b, fragment.nodes);
	return b.element();
}

function if_block(ctx: CompileContext, node: AST.IfBlock): string {
	let out = `{#if ${src(ctx, node.test)}}${branch(ctx, node.consequent)}`;
	let alt = node.alternate;
	while (alt) {
		const only = alt.nodes.filter((n) => !(n.type === 'Text' && !n.data.trim()));
		if (only.length === 1 && only[0].type === 'IfBlock' && only[0].elseif) {
			const e = only[0];
			out += `{:else if ${src(ctx, e.test)}}${branch(ctx, e.consequent)}`;
			alt = e.alternate;
		} else {
			out += `{:else}${branch(ctx, alt)}`;
			alt = null;
		}
	}
	return out + '{/if}';
}

function each_block(ctx: CompileContext, node: AST.EachBlock): string {
	let head = `{#each ${src(ctx, node.expression)}`;
	if (node.context) head += ` as ${src(ctx, node.context)}`;
	if (node.index) head += `, ${node.index}`;
	if (node.key) head += ` (${src(ctx, node.key)})`;
	head += '}';
	let out = head + branch(ctx, node.body);
	if (node.fallback) out += `{:else}${branch(ctx, node.fallback)}`;
	return out + '{/each}';
}

function await_block(ctx: CompileContext, node: AST.AwaitBlock): string {
	let out = `{#await ${src(ctx, node.expression)}}`;
	if (node.pending) out += branch(ctx, node.pending);
	if (node.then) out += `{:then${node.value ? ' ' + src(ctx, node.value) : ''}}${branch(ctx, node.then)}`;
	if (node.catch) out += `{:catch${node.error ? ' ' + src(ctx, node.error) : ''}}${branch(ctx, node.catch)}`;
	return out + '{/await}';
}

export function snippet_block(ctx: CompileContext, node: AST.SnippetBlock): string {
	// the opening tag as written: name, generics and parameters
	const body_start = node.body.nodes.length ? node.body.nodes[0].start : node.end - '{/snippet}'.length;
	const open = ctx.source.slice(node.start, body_start);
	const head = open.slice(0, open.lastIndexOf('}') + 1);
	return `${head}${branch(ctx, node.body)}{/snippet}`;
}

function emit_user_component(ctx: CompileContext, t: Template, node: AST.Component, tag = node.name) {
	const attrs = node.attributes.map((a) => src(ctx, a)).join(' ');
	const snippets: string[] = [];
	const rest: Node[] = [];
	for (const n of node.fragment.nodes) {
		if (n.type === 'SnippetBlock') snippets.push(snippet_block(ctx, n));
		else rest.push(n);
	}
	const children = is_blank(rest) ? '' : branch(ctx, { type: 'Fragment', nodes: rest } as AST.Fragment);
	emit_site(t, `<${tag}${attrs ? ' ' + attrs : ''}>${snippets.join('')}${children}</${tag}>`);
}

// ---- values -------------------------------------------------------------------------------------

/** What markup gave an attribute. */
export function attr_source(ctx: CompileContext, a: AST.Attribute): Source {
	const v = a.value;
	if (v === true) return { kind: 'static', value: true };
	const parts = Array.isArray(v) ? v : [v];
	if (parts.length === 1 && parts[0].type === 'ExpressionTag') {
		const e = parts[0].expression as unknown as { type: string; value?: unknown; start: number; end: number; expressions?: unknown[]; quasis?: { value: { cooked: string } }[]; elements?: unknown[]; operator?: string; argument?: { type: string; value?: unknown } };
		const lit = literal_of(e);
		if (lit !== undefined) return { kind: 'static', value: lit };
		return { kind: 'expr', js: src(ctx, e), node: a };
	}
	const text = text_of(ctx, parts as Node[]);
	return text ?? { kind: 'static', value: '' };
}

/** The value of a literal expression (numbers, strings, booleans, arrays of them), else undefined. */
export function literal_of(e: unknown): unknown {
	const n = e as { type: string; value?: unknown; expressions?: unknown[]; quasis?: { value: { cooked: string } }[]; elements?: unknown[]; operator?: string; argument?: unknown };
	if (!n) return undefined;
	if (n.type === 'Literal') return n.value === null ? null : n.value;
	if (n.type === 'TemplateLiteral' && n.expressions?.length === 0) return n.quasis![0].value.cooked;
	if (n.type === 'UnaryExpression' && n.operator === '-') {
		const v = literal_of(n.argument);
		return typeof v === 'number' ? -v : undefined;
	}
	if (n.type === 'ArrayExpression') {
		const out: unknown[] = [];
		for (const el of n.elements ?? []) {
			const v = literal_of(el);
			if (v === undefined) return undefined;
			out.push(v);
		}
		return out;
	}
	if (n.type === 'Identifier' && (n as unknown as { name: string }).name === 'undefined') return null;
	return undefined;
}

/** A string value (label, text, optional string option). */
export function string_val(t: Template, s: Source): Val {
	if (s.kind === 'static') {
		if (s.value == null || s.value === false) return { c: '""', dynamic: false };
		return { c: c_string(String(s.value)), dynamic: false };
	}
	return { c: `cuisv_str(s, ${t.slot('s', s.js)})`, dynamic: true };
}

const INT_TYPES = new Set(['int', 'size_t', 'uint32_t', 'uint8_t', 'int64_t', 'uint64_t', 'unsigned', 'long']);

/**
 * A value for a C type. `name` is the field or parameter name, which tells icons from other
 * strings. Returns null (and warns) when markup gave something that type cannot take.
 */
export function typed_val(ctx: CompileContext, t: Template, type: string, name: string, s: Source, node?: AnyNode): Val | null {
	if (s.kind === 'bind') return null;
	const fail = (what: string) => {
		warn(ctx, 'bad_value', `${name}: ${what}`, node as never);
		return null;
	};
	if (type === 'bool') {
		if (s.kind === 'static') return { c: s.value === false || s.value === 'false' || s.value == null ? 'false' : 'true', dynamic: false };
		return { c: `cuisv_bool(s, ${t.slot('b', s.js)})`, dynamic: true };
	}
	if (type === 'float' || type === 'double' || INT_TYPES.has(type)) {
		const reader = type === 'float' ? 'cuisv_float' : type === 'double' ? 'cuisv_num' : 'cuisv_int';
		if (s.kind === 'static') {
			const n = typeof s.value === 'number' ? s.value : parse_length(s.value);
			if (n === null || typeof n !== 'number') return fail(`expected a number, got ${JSON.stringify(s.value)}`);
			return { c: type === 'float' ? c_float(n) : INT_TYPES.has(type) ? String(Math.trunc(n)) : String(n), dynamic: false };
		}
		return { c: `${reader}(s, ${t.slot('n', s.js)})`, dynamic: true };
	}
	if (type === 'const char *') {
		const icon = /icon/.test(name);
		if (s.kind === 'static') {
			if (s.value == null || s.value === false) return { c: 'NULL', dynamic: false };
			if (icon) {
				const k = icon_constant(String(s.value));
				if (k) return { c: k, dynamic: false };
			}
			return { c: c_string(String(s.value)), dynamic: false };
		}
		const js = icon ? `__cuisv_h.icon(${s.js})` : s.js;
		return { c: `cuisv_cstr(s, ${t.slot('s', js)})`, dynamic: true };
	}
	if (is_enum(type)) {
		if (s.kind === 'static') {
			if (typeof s.value === 'number') return { c: `(${type})${Math.trunc(s.value)}`, dynamic: false };
			const k = enum_constant(type, String(s.value));
			if (!k) return fail(`"${s.value}" is not one of ${enum_names(type).join(', ')}`);
			return { c: k, dynamic: false };
		}
		return { c: `(${type})cuisv_int(s, ${t.slot('n', `__cuisv_h.en(${s.js}, ${JSON.stringify(type)})`)})`, dynamic: true };
	}
	if (type === 'cui_size') {
		if (s.kind === 'static') {
			const z = parse_size(s.value);
			if (!z) return fail(`expected a size (240, "50%", "fill", "fit"), got ${JSON.stringify(s.value)}`);
			return { c: c_size(z.kind, z.value), dynamic: false };
		}
		return { c: `cuisv_size(s, ${t.slot('n', `__cuisv_h.size(${s.js})`)}, CUI_FIT)`, dynamic: true };
	}
	if (type === 'cui_color') {
		if (s.kind === 'static') {
			const col = parse_color(s.value);
			if (!col) return fail(`expected a color, got ${JSON.stringify(s.value)}`);
			return { c: c_color(col), dynamic: false };
		}
		return { c: `cuisv_color(s, ${t.slot('n', `__cuisv_h.color(${s.js})`)}, CUI_TRANSPARENT)`, dynamic: true };
	}
	if (type === 'cui_texture') {
		if (s.kind === 'static') return fail('expected an image from load_image()');
		return { c: `(cui_texture)cuisv_num(s, ${t.slot('n', `__cuisv_h.texture(${s.js})`)})`, dynamic: true };
	}
	if (type === 'const char *const *') {
		if (s.kind === 'static') {
			if (!Array.isArray(s.value)) return fail('expected an array of strings');
			return { c: static_strs(s.value.map(String), /icon/.test(name)), dynamic: false };
		}
		const js = /icon/.test(name) ? `__cuisv_h.icons(${s.js})` : s.js;
		return { c: `cuisv_strs(s, ${t.slot('a', js)}, &(int){0})`, dynamic: true };
	}
	if (type === 'const float *') {
		if (s.kind === 'static') {
			if (!Array.isArray(s.value)) return fail('expected an array of numbers');
			return { c: static_floats(s.value), dynamic: false };
		}
		return { c: `cuisv_floats(s, ${t.slot('d', s.js)}, &(int){0})`, dynamic: true };
	}
	return fail(`${type} options are not supported yet`);
}

/** Data CUI may read after the template returns (it paints at the end of the frame), so it
 * lives at file scope rather than in a compound literal. */
let static_counter = 0;
export const STATICS: string[] = [];
export function reset_statics() {
	STATICS.length = 0;
	static_counter = 0;
}

function static_strs(items: string[], icons: boolean): string {
	const parts = items.map((x) => (icons ? icon_constant(x) ?? c_string(x) : c_string(x)));
	const name = `cuisv_strs_${static_counter++}`;
	STATICS.push(`static const char *const ${name}[] = { ${parts.join(', ') || 'NULL'} };`);
	return name;
}

function static_floats(values: unknown[]): string {
	const name = `cuisv_floats_${static_counter++}`;
	STATICS.push(`static const float ${name}[] = { ${values.map((x) => c_float(Number(x))).join(', ') || '0'} };`);
	return name;
}

// ---- intrinsic components ---------------------------------------------------------------------------

interface Gathered {
	/** prop -> source, from attributes (and CSS, lowest). */
	props: Map<string, Source>;
	nodes: Map<string, AnyNode>;
	events: Map<string, string>;
	binds: Map<string, { js: string; set: string; node: AnyNode }>;
	classes: string[];
	tooltip?: Source;
}

/** A bound value: JS that reads it and a function that writes it. */
export interface Bound {
	js: string;
	set: string;
}

/** bind:x={target} or bind:x={get, set}. */
export function setter_of(ctx: CompileContext, expr: unknown): Bound {
	const e = expr as { type: string; expressions?: unknown[] };
	if (e.type === 'SequenceExpression' && e.expressions?.length === 2) {
		const [g, s] = e.expressions;
		return { js: `(${src(ctx, g)})()`, set: src(ctx, s) };
	}
	const target = src(ctx, e);
	return { js: target, set: `(__cuisv_v) => { ${target} = __cuisv_v; }` };
}

/**
 * The slot of a value markup binds (with its setter), gives as an expression, or leaves to C
 * (`own`: C keeps it, starting from the literal markup gave, if any). `wrap` adapts the JS.
 */
export function value_slot(t: Template, kind: string, bound: Bound | null | undefined, given: Source | null | undefined, wrap = (js: string) => js) {
	if (bound) {
		const slot = t.slot(kind, wrap(bound.js));
		return { slot, setter: t.setter(slot, bound.set), own: false };
	}
	const expr = given?.kind === 'expr';
	return { slot: t.slot(kind, expr ? wrap(given.js) : null), setter: -1, own: !expr };
}

/** C that sets a string slot C keeps to its first value. */
export function init_str(slot: number, value: string): string {
	return `if (!cuisv_has(s, ${slot})) cuisv_set_str(s, ${slot}, ${c_string(value)}, ${new TextEncoder().encode(value).length});`;
}

export function gather(ctx: CompileContext, node: AST.Component | AST.RegularElement, spec_name: string): Gathered {
	const g: Gathered = { props: new Map(), nodes: new Map(), events: new Map(), binds: new Map(), classes: [] };
	for (const a of node.attributes) {
		switch (a.type) {
			case 'Attribute': {
				if (/^on[a-z]+$/.test(a.name)) {
					const s = attr_source(ctx, a);
					if (s.kind === 'expr') g.events.set(a.name, s.js);
					else warn(ctx, 'bad_event', `${a.name} needs a function`, a);
					break;
				}
				if (a.name === 'tooltip') {
					g.tooltip = attr_source(ctx, a);
					break;
				}
				g.props.set(a.name, attr_source(ctx, a));
				g.nodes.set(a.name, a);
				break;
			}
			case 'BindDirective':
				g.binds.set(a.name, { ...setter_of(ctx, a.expression), node: a as never });
				break;
			case 'ClassDirective':
			case 'StyleDirective':
				// handled by the style resolver
				break;
			case 'SpreadAttribute':
				warn(ctx, 'spread', `{...spread} on <${spec_name}> is not supported yet; pass the props one by one`, a);
				break;
			case 'OnDirective':
				warn(ctx, 'on_directive', `on:${a.name} is Svelte 4 syntax; use on${a.name}={...}`, a);
				break;
			default:
				warn(ctx, 'unsupported_directive', `${a.type} on <${spec_name}> is not supported`, a as never);
		}
	}
	return g;
}

/** Applies the C side of bound and plain params; returns the C argument for the param. */
interface Arg {
	c: string;
	pre: string[];
	post: string[];
	/** C local that holds the value (binds), for event payloads. */
	local?: string;
	changed?: string;
	/** For values that travel as bytes: C that emits the value to an event slot, and the JS
	 * function that turns the bytes back into the JS value. */
	emit?: (slot: number) => string;
	decode?: string;
}

/** C for a scalar CUI reads and writes through a pointer, by bind_kind. */
const BIND_C = {
	bool: { slot: 'b', reader: 'cuisv_bool', writer: 'cuisv_set_bool', emitter: 'cuisv_emit_bool' },
	int: { slot: 'n', reader: 'cuisv_int', writer: 'cuisv_set_num', emitter: 'cuisv_emit_num' },
	float: { slot: 'n', reader: 'cuisv_float', writer: 'cuisv_set_num', emitter: 'cuisv_emit_num' },
	double: { slot: 'n', reader: 'cuisv_num', writer: 'cuisv_set_num', emitter: 'cuisv_emit_num' }
};

/** After the call: when the argument changed, these statements (null ones left out). */
function on_change(arg: Arg, ...lines: (string | null)[]) {
	const l = lines.filter((x) => x !== null);
	if (l.length) arg.post.push(`if (${arg.changed}) { ${l.join(' ')} }`);
}

function param_arg(ctx: CompileContext, t: Template, spec: Spec, p: ParamSpec, g: Gathered, key: string, children_text: Source | null, node: AnyNode): Arg {
	const arg: Arg = { c: '0', pre: [], post: [] };
	const given = g.props.get(p.prop);
	const bound = g.binds.get(p.prop);
	const local = `p_${p.name}`;
	/** A setter for bound bytes: `decoded` is JS over the bytes `b`. */
	const bytes_setter = (slot: number, decoded: string) => (bound ? t.setter(slot, `(b) => (${bound.set})(${decoded})`) : -1);
	switch (p.role) {
		case 'id': {
			// some components draw their id as a caption (knob, fader): "##key" draws nothing,
			// and text children become the visible part
			if (given) {
				const v = string_val(t, given);
				arg.c = v.c;
			} else if (children_text && !spec.params.some((q) => q.role === 'label' || q.role === 'text')) {
				arg.c = children_text.kind === 'static' ? c_string(`${children_text.value}##${key}`) : `cuisv_fmt("%s##%s", ${string_val(t, children_text).c}, ${c_string(key)})`;
			} else arg.c = c_string(`##${key}`);
			return arg;
		}
		case 'label':
		case 'text': {
			let s = given ?? children_text;
			if (p.prop === 'label' && !given && g.props.has('title')) s = g.props.get('title')!;
			if (!s) {
				if (p.default) {
					arg.c = p.default;
					return arg;
				}
				s = { kind: 'static', value: '' };
			}
			if (p.role === 'label') {
				if (s.kind === 'static') arg.c = c_string(`${s.value ?? ''}###${key}`);
				else arg.c = `cuisv_label(${string_val(t, s).c}, ${c_string(key)})`;
			} else {
				arg.c = string_val(t, s).c;
			}
			return arg;
		}
		case 'icon': {
			const v = given ? typed_val(ctx, t, 'const char *', 'icon', given, g.nodes.get(p.prop)) : null;
			arg.c = v?.c ?? p.default ?? '""';
			return arg;
		}
		case 'value': {
			const v = given ? typed_val(ctx, t, p.type, p.name, given, g.nodes.get(p.prop)) : null;
			const tex = spec.params.find((q) => q.role === 'texture');
			const auto = !v && tex && /^image_(w|h)$/.test(p.name) ? `t${p.name.slice(-1)}_${tex.name}` : null;
			arg.c = v?.c ?? auto ?? p.default ?? zero_of(p.type);
			return arg;
		}
		case 'strs':
		case 'floats': {
			const v = given ? typed_val(ctx, t, p.type, p.name, given, g.nodes.get(p.prop)) : null;
			if (!v) {
				arg.c = 'NULL, 0';
				return arg;
			}
			if (v.dynamic) {
				const n = `n_${p.name}`;
				arg.pre.push(`int ${n} = 0;`);
				arg.c = `${v.c.replace('&(int){0}', '&' + n)}, ${n}`;
			} else {
				const count = Array.isArray((given as { value: unknown[] }).value) ? (given as { value: unknown[] }).value.length : 0;
				arg.pre.push(`int n_${p.name} = ${count};`);
				arg.c = `${v.c}, n_${p.name}`;
			}
			return arg;
		}
		case 'bind': {
			const kind = bind_kind(p.type)!;
			const b = BIND_C[kind];
			const { slot, setter, own } = value_slot(t, b.slot, bound, given);
			const init = given?.kind === 'static' ? given.value : p.default;
			if (own && init != null) {
				const iv = kind === 'bool' ? (init === true || init === 'true' ? 'true' : 'false') : String(Number(init));
				arg.pre.push(`if (!cuisv_has(s, ${slot})) ${b.writer}(s, ${slot}, ${iv});`);
			}
			arg.pre.push(`${kind} ${local} = ${b.reader}(s, ${slot});`);
			arg.pre.push(`${kind} ${local}_was = ${local};`);
			arg.c = `&${local}`;
			arg.local = local;
			arg.changed = `${local} != ${local}_was`;
			on_change(arg, `${b.writer}(s, ${slot}, ${local});`, setter >= 0 ? `${b.emitter}(s, ${setter}, ${local});` : null);
			return arg;
		}
		case 'buffer': {
			const { slot, setter, own } = value_slot(t, 's', bound, given);
			if (own && given?.kind === 'static' && given.value != null) arg.pre.push(init_str(slot, String(given.value)));
			arg.pre.push(`size_t cap_${p.name}; char *${local} = cuisv_buf(s, ${slot}, 256, &cap_${p.name});`);
			arg.c = `${local}, cap_${p.name}`;
			arg.local = local;
			arg.changed = spec.buffer_changed ?? (spec.ret === 'bool' ? 'r' : '(r & CUI_CHANGED)');
			on_change(arg, `cuisv_buf_changed(s, ${slot}, ${setter});`);
			return arg;
		}
		case 'records':
		case 'records_mut': {
			const T = p.type.replace(/^const /, '').replace(/ \*$/, '');
			const sd = ctx.records.c_desc(T);
			const desc = Records.js_desc(T);
			const js = bound ? bound.js : given ? js_of(given) : null;
			const slot = t.slot('o', js === null ? null : `__cuisv_h.pack(${js}, ${desc})`);
			const rec = `rec_${p.name}`;
			arg.pre.push(`const cuisv_records *${rec} = cuisv_records_get(s, ${slot}, ${sd});`);
			arg.c = `(${p.role === 'records' ? 'const ' : ''}${T} *)${rec}->items, ${rec}->count`;
			if (p.role === 'records_mut') {
				arg.pre.push(`size_t sz_${p.name} = (size_t)${rec}->count * sizeof(${T});`);
				arg.pre.push(`void *was_${p.name} = cuisv_frame_alloc(sz_${p.name} ? sz_${p.name} : 1); memcpy(was_${p.name}, ${rec}->items, sz_${p.name});`);
				arg.changed = `memcmp(was_${p.name}, ${rec}->items, sz_${p.name}) != 0`;
				arg.emit = (ev) => `cuisv_emit_records(s, ${ev}, ${sd}, ${rec}->items, ${rec}->count);`;
				arg.decode = `(b) => __cuisv_h.unpack(b, ${desc})`;
				if (bound) on_change(arg, arg.emit(t.setter(slot, `(b) => __cuisv_h.merge(${bound.js}, __cuisv_h.unpack(b, ${desc}), ${bound.set})`)));
			}
			return arg;
		}
		case 'bind_struct':
		case 'struct_value': {
			const T = p.type.replace(/ \*$/, '');
			const local_t = `p_${p.name}`;
			// a date written as text is known now
			if (p.role === 'struct_value' && T === 'cui_date' && (!given || given.kind === 'static')) {
				const v = given?.kind === 'static' ? String(given.value) : 'today';
				const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(v);
				arg.c = m ? `(cui_date){ ${Number(m[1])}, ${Number(m[2])}, ${Number(m[3])} }` : 'cui_date_today()';
				return arg;
			}
			const sd = ctx.records.c_desc(T);
			const desc = Records.js_desc(T);
			const js = bound ? bound.js : given ? js_of(given) : null;
			const slot = t.slot('o', js === null ? null : `__cuisv_h.pack(__cuisv_h.to_record(${JSON.stringify(T)}, ${js}), ${desc})`);
			arg.pre.push(`${T} ${local_t}; cuisv_record_read(s, ${slot}, ${sd}, &${local_t});`);
			if (p.role === 'struct_value') {
				arg.c = local_t;
				return arg;
			}
			if (T === 'cui_date' && !js) arg.pre.push(`if (!${local_t}.year) ${local_t} = cui_date_today();`);
			arg.pre.push(`${T} ${local_t}_was = ${local_t};`);
			arg.c = `&${local_t}`;
			arg.local = local_t;
			arg.changed = `memcmp(&${local_t}, &${local_t}_was, sizeof ${local_t}) != 0`;
			const decoded = `__cuisv_h.record_value(b, ${desc}, ${JSON.stringify(T)})`;
			arg.decode = `(b) => ${decoded}`;
			arg.emit = (ev) => `cuisv_emit_records(s, ${ev}, ${sd}, &${local_t}, 1);`;
			on_change(arg, `cuisv_record_write(s, ${slot}, ${bytes_setter(slot, decoded)}, ${sd}, &${local_t});`);
			return arg;
		}
		case 'bind_bools': {
			const js = bound ? bound.js : given?.kind === 'expr' ? given.js : null;
			const slot = t.slot('o', js === null ? null : `__cuisv_h.bools(${js})`);
			// the list before it gives the length
			const list = spec.params.find((q) => q.role === 'strs');
			const n = list ? `n_${list.name}` : '0';
			arg.pre.push(`bool *${local} = cuisv_bools(s, ${slot}, ${n});`);
			arg.pre.push(`bool *${local}_was = cuisv_frame_alloc((size_t)(${n} > 0 ? ${n} : 1)); memcpy(${local}_was, ${local}, (size_t)${n});`);
			arg.c = local;
			arg.changed = `memcmp(${local}, ${local}_was, (size_t)${n}) != 0`;
			arg.emit = (ev) => `cuisv_emit_bytes(s, ${ev}, ${local}, (uint32_t)${n});`;
			const decoded = 'Array.from(b, Boolean)';
			arg.decode = `(b) => ${decoded}`;
			const setter = bytes_setter(slot, decoded);
			on_change(arg, `cuisv_slot_bools(s, ${slot}, ${local}, ${n});`, setter >= 0 ? arg.emit(setter) : null);
			return arg;
		}
		case 'bind_floats': {
			const js = bound ? bound.js : given?.kind === 'expr' ? given.js : null;
			const slot = t.slot('d', js);
			const count = spec.params[spec.params.indexOf(p) + 1];
			const n = `n_${p.name}`;
			arg.pre.push(`int ${n} = 0; const float *src_${p.name} = cuisv_floats(s, ${slot}, &${n});`);
			arg.pre.push(`if (${n} < 4) ${n} = 4;`);
			arg.pre.push(`float ${local}[16] = {0}; if (src_${p.name}) memcpy(${local}, src_${p.name}, sizeof(float) * (size_t)(cuisv_slot(s, ${slot})->u.floats.count < 16 ? cuisv_slot(s, ${slot})->u.floats.count : 16));`);
			arg.pre.push(`float ${local}_was[16]; memcpy(${local}_was, ${local}, sizeof ${local});`);
			const comps = g.props.get(count?.prop ?? '') ;
			const comps_c = comps?.kind === 'static' ? String(Number(comps.value)) : count?.default ?? '3';
			arg.c = `${local}, ${comps_c}`;
			arg.changed = `memcmp(${local}, ${local}_was, sizeof ${local}) != 0`;
			arg.emit = (ev) => `cuisv_emit_bytes(s, ${ev}, ${local}, (uint32_t)(sizeof(float) * (${comps_c})));`;
			const decoded = 'Array.from(new Float32Array(b.slice().buffer))';
			arg.decode = `(b) => ${decoded}`;
			const setter = bytes_setter(slot, decoded);
			on_change(arg, `cuisv_slot_floats_set(s, ${slot}, ${local}, ${comps_c});`, setter >= 0 ? arg.emit(setter) : null);
			return arg;
		}
		case 'texture': {
			const v = given ?? g.props.get('src');
			if (!v) {
				arg.c = '0';
				return arg;
			}
			const sv = string_val(t, v.kind === 'expr' ? { kind: 'expr', js: `__cuisv_h.image_src(${v.js})` } : v);
			arg.pre.push(`int tw_${p.name} = 0, th_${p.name} = 0; cui_texture ${local} = cuisv_image(ui, ${sv.c}, &tw_${p.name}, &th_${p.name});`);
			arg.c = local;
			return arg;
		}
		case 'host_object': {
			const v = given ?? null;
			const slot = t.slot('n', v ? (v.kind === 'expr' ? `__cuisv_h.handle(${v.js})` : 'undefined') : null);
			arg.c = p.type === 'cui_log_buffer *' ? `cuisv_log_buffer(cuisv_num(s, ${slot}))` : `cuisv_terminal_buffer(cuisv_num(s, ${slot}))`;
			return arg;
		}
		case 'records_cap': {
			const T = p.type.replace(/ \*$/, '');
			const sd = ctx.records.c_desc(T);
			const desc = Records.js_desc(T);
			const js = bound ? bound.js : given ? js_of(given) : null;
			const slot = t.slot('o', js === null ? null : `__cuisv_h.pack(${js}, ${desc})`);
			const capg = g.props.get('capacity');
			const rec = `rec_${p.name}`;
			arg.pre.push(`const cuisv_records *${rec} = cuisv_records_get(s, ${slot}, ${sd});`);
			arg.pre.push(`int cap_${p.name} = ${capg?.kind === 'static' ? Number(capg.value) : `${rec}->count + 32`}; if (cap_${p.name} < ${rec}->count) cap_${p.name} = ${rec}->count;`);
			arg.pre.push(`${T} *${local} = cuisv_frame_alloc(sizeof(${T}) * (size_t)(cap_${p.name} > 0 ? cap_${p.name} : 1)); memcpy(${local}, ${rec}->items, sizeof(${T}) * (size_t)${rec}->count);`);
			arg.pre.push(`int n_${p.name} = ${rec}->count, n_${p.name}_was = n_${p.name};`);
			arg.c = `${local}, &n_${p.name}, cap_${p.name}`;
			arg.changed = `(n_${p.name} != n_${p.name}_was || memcmp(${local}, ${rec}->items, sizeof(${T}) * (size_t)n_${p.name}) != 0)`;
			arg.emit = (ev) => `cuisv_emit_records(s, ${ev}, ${sd}, ${local}, n_${p.name});`;
			arg.decode = `(b) => __cuisv_h.unpack(b, ${desc})`;
			const setter = bound ? t.setter(slot, `(b) => __cuisv_h.merge(${bound.js}, __cuisv_h.unpack(b, ${desc}), ${bound.set})`) : -1;
			on_change(arg, `cuisv_records_store(s, ${slot}, ${sd}, ${local}, n_${p.name});`, setter >= 0 ? arg.emit(setter) : null);
			return arg;
		}
		case 'bind_u32s': {
			const js = bound ? bound.js : given?.kind === 'expr' ? given.js : null;
			const slot = t.slot('o', js === null ? null : `__cuisv_h.u32s(${js})`);
			const list = spec.params.find((q) => q.role === 'records');
			const n = list ? `rec_${list.name}->count` : '0';
			arg.pre.push(`uint32_t *${local} = cuisv_u32s(s, ${slot}, ${n});`);
			arg.pre.push(`uint32_t *${local}_was = cuisv_frame_alloc(sizeof(uint32_t) * (size_t)(${n} > 0 ? ${n} : 1)); memcpy(${local}_was, ${local}, sizeof(uint32_t) * (size_t)${n});`);
			arg.c = local;
			arg.changed = `memcmp(${local}, ${local}_was, sizeof(uint32_t) * (size_t)${n}) != 0`;
			arg.emit = (ev) => `cuisv_emit_bytes(s, ${ev}, ${local}, (uint32_t)(sizeof(uint32_t) * (size_t)${n}));`;
			const decoded = 'Array.from(new Uint32Array(b.slice().buffer))';
			arg.decode = `(b) => ${decoded}`;
			const setter = bytes_setter(slot, decoded);
			on_change(arg, `cuisv_slot_blob(s, ${slot}, (const uint8_t *)${local}, (uint32_t)(sizeof(uint32_t) * (size_t)${n}));`, setter >= 0 ? arg.emit(setter) : null);
			return arg;
		}
		case 'skip':
			// a count travels with its array; any other skipped parameter is its C default
			return { c: p.count ? '' : (p.default ?? ''), pre: [], post: [] };
		default:
			warn(ctx, 'unsupported_param', `${spec.name}: ${p.prop} (${p.type}) is not supported yet`, node as never);
			arg.c = zero_of(p.type);
			return arg;
	}
}

function zero_of(type: string): string {
	if (type === 'cui_size') return 'CUI_FIT';
	if (type === 'cui_color') return 'CUI_TRANSPARENT';
	if (type.endsWith('*')) return 'NULL';
	if (is_enum(type)) return `(${type})0`;
	if (type in api.structs) return `(${type}){0}`;
	return '0';
}

/** Options struct assignments for every field markup (or CSS) set. `post` runs after the call. */
function opts_lines(ctx: CompileContext, t: Template, spec: Spec, g: Gathered, used: Set<string>, style: ElementStyle | null, post: string[]): string[] {
	const lines: string[] = [];
	if (!spec.opts) return lines;
	// CSS first (lowest), then attributes, which always win
	if (style) {
		const explicit = new Set([...g.props.keys()].filter((k) => spec.fields.has(k)));
		const parent = ctx.ancestors[ctx.ancestors.length - 1];
		lines.push(...apply_fields(style, spec.fields, t, { parent_dir: parent?.dir ?? null, explicit, opts: 'o' }));
	}
	// pointer fields: values CUI reads and writes (a table's sort, a grid's cursor)
	for (const [name, f] of spec.fields) {
		if (!f.type.endsWith(' *') || f.type.startsWith('const ') || used.has(name)) continue;
		const bound = g.binds.get(name);
		const given = g.props.get(name);
		if (!bound && !given) continue;
		used.add(name);
		const T = f.type.slice(0, -2);
		const local = `po_${name}`;
		const kind = bind_kind(f.type);
		const js = bound ? bound.js : js_of(given!);
		if (kind) {
			const b = BIND_C[kind];
			const slot = t.slot(b.slot, js);
			const setter = bound ? t.setter(slot, bound.set) : -1;
			lines.push(`${kind} ${local} = ${b.reader}(s, ${slot}); ${kind} ${local}_was = ${local};`);
			lines.push(`o.${name} = &${local};`);
			post.push(`if (${local} != ${local}_was) { ${b.writer}(s, ${slot}, ${local});${setter >= 0 ? ` ${b.emitter}(s, ${setter}, ${local});` : ''} }`);
		} else if (T in api.structs) {
			const sd = ctx.records.c_desc(T);
			const desc = Records.js_desc(T);
			const slot = t.slot('o', `__cuisv_h.pack(__cuisv_h.to_record(${JSON.stringify(T)}, ${js}), ${desc})`);
			const setter = bound ? t.setter(slot, `(b) => (${bound.set})(__cuisv_h.record_value(b, ${desc}, ${JSON.stringify(T)}))`) : -1;
			lines.push(`${T} ${local}; cuisv_record_read(s, ${slot}, ${sd}, &${local}); ${T} ${local}_was = ${local};`);
			lines.push(`o.${name} = &${local};`);
			post.push(`if (memcmp(&${local}, &${local}_was, sizeof ${local}) != 0) { cuisv_record_write(s, ${slot}, ${setter}, ${sd}, &${local}); }`);
		} else {
			warn(ctx, 'unsupported_field', `${spec.name}: ${name} (${f.type}) is not supported yet`, g.nodes.get(name) as never);
		}
	}
	for (const [prop, s] of g.props) {
		if (used.has(prop)) continue;
		const f = spec.fields.get(prop);
		if (!f) continue;
		used.add(prop);
		if (f.array) {
			warn(ctx, 'unsupported_field', `${spec.name}: ${prop} is not supported yet`, g.nodes.get(prop) as never);
			continue;
		}
		const v = typed_val(ctx, t, f.type, f.name, s, g.nodes.get(prop));
		if (!v) continue;
		if (f.type === 'const char *const *' || f.type === 'const float *') {
			// arrays in options are paired with a count field that follows them
			const fields = [...spec.fields.values()];
			const idx = fields.findIndex((x) => x.name === f.name);
			const count = fields.slice(idx + 1).find((x) => /count$/.test(x.name) && (x.type === 'int' || x.type === 'size_t'));
			if (v.dynamic) {
				const n = `n_o_${f.name}`;
				lines.push(`int ${n} = 0;`);
				lines.push(`o.${f.name} = ${v.c.replace('&(int){0}', '&' + n)};`);
				if (count) lines.push(`o.${count.name} = ${n};`);
			} else {
				lines.push(`o.${f.name} = ${v.c};`);
				if (count && Array.isArray((s as { value: unknown[] }).value)) lines.push(`o.${count.name} = ${(s as { value: unknown[] }).value.length};`);
			}
			continue;
		}
		lines.push(`o.${f.name} = ${v.c};`);
	}
	return lines;
}

function emit_component(ctx: CompileContext, t: Template, node: AST.Component, spec: Spec) {
	if (spec.custom && SPECIAL[spec.custom]) return SPECIAL[spec.custom](ctx, t, node, spec);
	let key = t.key();
	const g = gather(ctx, node, spec.name);
	// id="…": the component's identity, findable from JS (rect_of, scroll_to, tests)
	const user_id = g.props.get('id');
	const has_id_param = spec.params.some((p) => p.role === 'id');
	const has_label = spec.params.some((p) => p.role === 'label');
	let name_line: string | null = null;
	if (user_id) {
		if (user_id.kind === 'static' && (has_label || has_id_param || spec.fields.has('id'))) {
			if (has_label && !has_id_param) key = String(user_id.value);
			name_line = `cuisv_name(ui, ${c_string(String(user_id.value))}, ${c_string(has_label && !has_id_param ? `###${user_id.value}` : String(user_id.value))});`;
		} else if (user_id.kind === 'expr' && (has_id_param || spec.fields.has('id'))) {
			const v = string_val(t, user_id);
			name_line = `cuisv_name(ui, ${v.c}, ${v.c});`;
			if (!has_id_param) g.props.set('id', { kind: 'expr', js: `(${user_id.js}) ?? ''` });
		}
	}
	const info = ctx.styles.info(node, t, ctx, null);
	const style = ctx.styles.resolve(info, ctx.ancestors);
	const inline = inline_layer(ctx, node, (m) => warn(ctx, 'css_unsupported', m, node));
	if (inline) style.layers.push(inline);
	// CUI components draw their own hover and press states
	bind_pointer(style, '((cuisv_pointer){0})');
	info.dir = spec.name === 'Row' ? 'row' : spec.kind === 'call' ? null : 'column';
	const used = new Set<string>();
	// text children
	let children_text: Source | null = null;
	const kids = node.fragment.nodes;
	if (spec.children === 'label' || spec.children === 'text') {
		if (kids.some((n) => n.type !== 'Text' && n.type !== 'ExpressionTag' && n.type !== 'Comment')) {
			warn(ctx, 'label_children', `<${node.name}> takes text only; markup inside it is left out`, node);
		}
		children_text = text_of(ctx, kids.filter((n) => n.type === 'Text' || n.type === 'ExpressionTag'));
	} else if (spec.children === 'none' && !is_blank(kids)) {
		warn(ctx, 'no_children', `<${node.name}> takes no children; they are left out`, node);
	}

	t.open(`{ /* <${node.name}> ${key} */`);
	if (name_line) t.line(name_line);
	const args: Arg[] = [];
	for (const p of spec.params) {
		used.add(p.prop);
		const a = param_arg(ctx, t, spec, p, g, key, children_text, node);
		args.push(a);
		for (const l of a.pre) t.line(l);
	}
	if (g.props.has('title') && spec.params.some((p) => p.prop === 'label')) used.add('title');
	const opts_post: string[] = [];
	const o_lines = opts_lines(ctx, t, spec, g, used, style, opts_post);
	if (spec.opts) {
		t.line(`${spec.opts} o = {0};`);
		for (const l of o_lines) t.line(l);
	}
	for (const prop of g.props.keys()) {
		if (!used.has(prop) && prop !== 'class' && prop !== 'style' && !(prop === 'id' && name_line)) {
			warn(ctx, 'unknown_prop', `<${node.name}> has no prop ${prop}` + (spec.fields.size ? ` (options: ${[...spec.fields.keys()].join(', ')})` : ''), g.nodes.get(prop) as never);
		}
	}
	const call_args = ['ui', ...args.map((a) => a.c).filter((c) => c !== ''), ...(spec.opts ? ['&o'] : [])].join(', ');
	const call = `${spec.fn}(${call_args})`;
	/** The call as a statement, with its result in `r` when it has one. */
	const emit_call = () => {
		if (spec.ret === 'void') return t.line(`${call};`);
		t.line(`${spec.ret} r = ${call};`);
		t.line('(void)r;');
	};

	// events: allocate a function slot for each one markup handles
	const ev_lines: string[] = [];
	for (const e of spec.events) {
		const js = g.events.get(e.name);
		if (!js) continue;
		let when = e.when.replace(/\$changed/g, args.find((a) => a.changed)?.changed ?? 'false');
		when = when.replace(/\$(\w+)/g, (_, n) => `p_${n}`);
		if (e.payload?.type === 'value') {
			const a = args.find((x) => x.emit && x.decode);
			if (a) {
				const slot = t.slot('f', `(b) => (${js})((${a.decode})(b))`);
				ev_lines.push(`if (${when}) { ${a.emit!(slot)} }`);
			}
			continue;
		}
		ev_lines.push(event_line(t, e, when, js));
	}
	for (const name of g.events.keys()) {
		if (!spec.events.some((e) => e.name === name) && !spec.end_events?.some((e) => e.name === name) && !spec.before_end?.events.some((e) => e.name === name)) {
			warn(ctx, 'unknown_event', `<${node.name}> has no ${name} event` + (spec.events.length ? ` (it has ${spec.events.map((e) => e.name).join(', ')})` : ''), node);
		}
	}

	const post = [...args.flatMap((a) => a.post), ...opts_post];
	// text style for what is inside a container
	let ts: string | null = null;
	if (spec.kind !== 'call') {
		const lines = text_style(style, t, `ts_${key}`);
		if (lines) {
			ts = `ts_${key}`;
			t.line(`cuisv_text_style ${ts} = {0};`);
			for (const l of lines) t.line(l);
		}
	} else if (spec.opts === 'cui_text_opts') {
		t.line('cuisv_text_inherit(&o);');
	}
	const none = display_none(style, t);
	if (none) t.open(`if (!${none}) {`);
	const inside = () => {
		if (ts) t.line(`cuisv_text_push(&${ts});`);
		ctx.ancestors.push(info);
		if (spec.between) {
			// <Split><A/><B/></Split>: the statement goes between the first two children
			const real = kids.filter((k) => !(k.type === 'Text' && !k.data.trim()) && k.type !== 'Comment');
			const at = kids.indexOf(real[1] ?? real[real.length - 1]);
			walk(ctx, t, real.length > 1 ? kids.slice(0, at) : kids);
			t.line(spec.between);
			if (real.length > 1) walk(ctx, t, kids.slice(at));
		} else walk(ctx, t, kids);
		ctx.ancestors.pop();
		if (ts) t.line('cuisv_text_pop();');
	};
	// end functions with a result (kanban moves, card stack swipes)
	const end_call = () => {
		if (spec.before_end) {
			t.line(spec.before_end.pre);
			for (const e of spec.before_end.events) {
				const js = g.events.get(e.name);
				if (js) t.line(event_line(t, e, e.when, js));
			}
		}
		if (spec.end_pre) t.line(spec.end_pre);
		const end_args = spec.end_args ? `ui, ${spec.end_args}` : 'ui';
		const end_events = (spec.end_events ?? []).filter((e) => g.events.has(e.name));
		const end_ret = api.functions[spec.end!]?.ret ?? 'void';
		if (end_events.length && end_ret !== 'void') {
			t.line(`${end_ret} e = ${spec.end}(${end_args});`);
			for (const e of end_events) t.line(event_line(t, e, e.when, g.events.get(e.name)!));
		} else t.line(`${spec.end}(${end_args});`);
	};
	if (spec.kind === 'call') {
		emit_call();
		emit_tooltip(t, g, spec);
		for (const l of post) t.line(l);
		for (const l of ev_lines) t.line(l);
		if (spec.children_after) inside();
	} else if (spec.kind === 'scope') {
		emit_call();
		inside();
		end_call();
		for (const l of post) t.line(l);
		for (const l of ev_lines) t.line(l);
	} else {
		t.open(`if (${call}) {`);
		inside();
		end_call();
		t.close();
		for (const l of post) t.line(l);
		for (const l of ev_lines) t.line(l.replace(/\br\b/g, 'true'));
	}
	if (none) t.close();
	t.close();
}

/** C that emits event `e` (when its condition holds) to a new function slot for `js`. */
export function event_line(t: Template, e: EventSpec, when: string, js: string): string {
	if (!e.payload) return `if (${when}) cuisv_emit(s, ${t.slot('f', js)});`;
	const expr = e.payload.expr.replace(/\$(\w+)/g, (_, n) => `p_${n}`);
	if (e.payload.type === 'json') return `if (${when}) cuisv_emit_str(s, ${t.slot('f', `(j) => (${js})(JSON.parse(j))`)}, ${expr});`;
	const emit = e.payload.type === 'bool' ? 'cuisv_emit_bool' : e.payload.type === 'str' ? 'cuisv_emit_str' : 'cuisv_emit_num';
	return `if (${when}) ${emit}(s, ${t.slot('f', js)}, ${expr});`;
}

function emit_tooltip(t: Template, g: Gathered, spec: Spec) {
	if (!g.tooltip) return;
	if (spec.fields.has('tooltip')) return;
	const v = string_val(t, g.tooltip);
	t.line(`cui_tooltip(ui, ${v.c});`);
}

