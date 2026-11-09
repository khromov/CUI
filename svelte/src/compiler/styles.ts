/**
 * <style>, resolved at build time.
 *
 * Every element's matching rules are found while the template is compiled: tags, classes
 * (static, `class:x`, or computed `class={…}`), ids, descendant and child combinators, and
 * :hover / :active / :focus-visible. Rules are cascaded by specificity and order and turned
 * into "facets" (css-props.ts) that each target applies to the C options it has. A rule
 * that depends on a dynamic class becomes a C condition over a boolean slot; a pointer
 * pseudo-class becomes a condition over the element's pointer state.
 */
import { globSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse, type AST } from 'svelte/compiler';
import { expand, facets as facets_of, type Facet, type FacetValue, type CssProblem } from './css-props.ts';
import { src, type CompileContext, type Template, type Warning } from './template.ts';
import { parse_color, parse_length, TOKENS } from '../shared/values.ts';

// ---- rules -----------------------------------------------------------------------------

interface Compound {
	tag: string | null;
	classes: string[];
	ids: string[];
	pseudo: string[];
	attrs: { name: string; value: string | null }[];
	/** Combinator between this compound and the one before it. */
	combinator: ' ' | '>' | null;
	universal: boolean;
}

interface Selector {
	parts: Compound[];
	specificity: [number, number, number];
}

export interface Rule {
	selectors: Selector[];
	decls: { property: string; value: string }[];
	order: number;
	global: boolean;
	file: string;
	/** Inside @media (prefers-color-scheme: …): applies with CUI's dark or light theme. */
	scheme?: 'dark' | 'light';
}

export type GlobalRules = Rule[];

let order_counter = 0;

/** :root, html and body are the window. */
const is_root = (parts: Compound[]) => parts.length === 1 && [':root', 'html', 'body'].includes(parts[0].tag ?? '');

function compound_of(rel: AST.CSS.RelativeSelector, warn: (m: string) => void, scoped_global: { value: boolean }): Compound | null {
	const c: Compound = { tag: null, classes: [], ids: [], pseudo: [], attrs: [], combinator: null, universal: false };
	const comb = rel.combinator?.name?.trim();
	c.combinator = comb === '>' ? '>' : comb ? (null as never) : ' ';
	if (comb && comb !== '>') {
		warn(`the ${comb} combinator is not supported`);
		return null;
	}
	for (const s of rel.selectors) {
		switch (s.type) {
			case 'TypeSelector':
				if (s.name === '*') c.universal = true;
				else c.tag = s.name.toLowerCase();
				break;
			case 'ClassSelector':
				c.classes.push(s.name);
				break;
			case 'IdSelector':
				c.ids.push(s.name);
				break;
			case 'AttributeSelector':
				c.attrs.push({ name: s.name, value: s.value ?? null });
				break;
			case 'PseudoClassSelector': {
				if (s.name === 'global') {
					scoped_global.value = true;
					// :global(.x) — take the inner selector's simple parts
					const inner = s.args?.children?.[0]?.children?.[0];
					if (inner) {
						const ic = compound_of(inner as AST.CSS.RelativeSelector, warn, scoped_global);
						if (ic) {
							c.tag ??= ic.tag;
							c.classes.push(...ic.classes);
							c.ids.push(...ic.ids);
							c.pseudo.push(...ic.pseudo);
						}
					}
					break;
				}
				if (['hover', 'active', 'focus', 'focus-visible', 'focus-within'].includes(s.name)) c.pseudo.push(s.name);
				else if (s.name === 'root') c.tag = ':root';
				else if (s.name === 'where' || s.name === 'is') {
					warn(`:${s.name}() is not supported`);
					return null;
				} else {
					warn(`:${s.name} is not supported`);
					return null;
				}
				break;
			}
			case 'PseudoElementSelector':
				warn(`::${s.name} has nothing to style in CUI`);
				return null;
			case 'NestingSelector':
				warn('nesting (&) is not supported');
				return null;
			default:
				warn(`${(s as { type: string }).type} selectors are not supported`);
				return null;
		}
	}
	return c;
}

function rules_of(ast: AST.Root, file: string, warn: (m: string) => void, only_global: boolean): Rule[] {
	const out: Rule[] = [];
	if (!ast.css) return out;
	const visit = (children: AST.CSS.StyleSheet['children'], in_global: boolean, scheme?: 'dark' | 'light') => {
		for (const node of children) {
			if (node.type === 'Atrule') {
				const scheme_m = node.name === 'media' ? /prefers-color-scheme\s*:\s*(dark|light)/.exec(node.prelude) : null;
				if (scheme_m && node.block) {
					visit(node.block.children as AST.CSS.StyleSheet['children'], in_global, scheme_m[1] as 'dark' | 'light');
				} else if (node.name === 'media' || node.name === 'supports' || node.name === 'container') {
					warn(`@${node.name} ${node.prelude} is left out (CUI lays out at one size: use wrap, grid min_column_width, or the viewport size); @media (prefers-color-scheme) works`);
				} else if (node.name !== 'charset' && node.name !== 'import' && node.name !== 'layer') {
					warn(`@${node.name} is not supported`);
				}
				continue;
			}
			if (node.type !== 'Rule') continue;
			const selectors: Selector[] = [];
			let global = in_global;
			for (const complex of node.prelude.children) {
				const g = { value: false };
				const parts: Compound[] = [];
				let ok = true;
				for (const rel of complex.children) {
					const c = compound_of(rel, warn, g);
					if (!c) {
						ok = false;
						break;
					}
					parts.push(c);
				}
				if (!ok || !parts.length) continue;
				parts[0].combinator = null;
				// :root and html/body are the window: global by nature
				if (is_root(parts)) g.value = true;
				if (g.value) global = true;
				let a = 0, b = 0, cc = 0;
				for (const p of parts) {
					a += p.ids.length;
					b += p.classes.length + p.pseudo.length + p.attrs.length;
					cc += p.tag && p.tag !== ':root' ? 1 : 0;
				}
				// scoped rules carry Svelte's scoping class
				if (!g.value) b += 1;
				selectors.push({ parts, specificity: [a, b, cc] });
			}
			const decls: { property: string; value: string }[] = [];
			for (const d of node.block.children) {
				if (d.type === 'Declaration') decls.push({ property: d.property, value: d.value });
				else warn('nested rules are not supported');
			}
			if (selectors.length && (!only_global || global)) out.push({ selectors, decls, order: order_counter++, global, file, scheme });
		}
	};
	visit(ast.css.children, false);
	return out;
}

/** :global rules from every .svelte file under root, which apply to all components. */
export function collect_globals(root: string): GlobalRules {
	const out: Rule[] = [];
	for (const f of globSync('**/*.svelte', { cwd: root, exclude: ['**/node_modules', '**/dist'] })) {
		const p = join(root, f);
		const src = readFileSync(p, 'utf8');
		if (!src.includes(':global') && !src.includes(':root')) continue;
		try {
			out.push(...rules_of(parse(src, { modern: true, filename: p }), p, () => {}, true).filter((r) => r.global));
		} catch {
			/* the file's own compile reports it */
		}
	}
	return out;
}

// ---- conditions -------------------------------------------------------------------------------

export type Cond = boolean | { js: string } | { c: string } | { and: Cond[] } | { or: Cond[] };

function and(a: Cond, b: Cond): Cond {
	if (a === false || b === false) return false;
	if (a === true) return b;
	if (b === true) return a;
	return { and: [a, b] };
}
function or(a: Cond, b: Cond): Cond {
	if (a === true || b === true) return true;
	if (a === false) return b;
	if (b === false) return a;
	return { or: [a, b] };
}

/** C for a condition in template t (JS conditions become boolean slots of t). */
export function cond_c(cond: Cond, t: Template): string {
	if (cond === true) return 'true';
	if (cond === false) return 'false';
	if ('js' in cond) return `cuisv_bool(s, ${t.cond_slot(cond.js)})`;
	if ('c' in cond) return cond.c;
	if ('and' in cond) return '(' + cond.and.map((x) => cond_c(x, t)).join(' && ') + ')';
	return '(' + cond.or.map((x) => cond_c(x, t)).join(' || ') + ')';
}

// ---- elements -----------------------------------------------------------------------------------

export interface ElementInfo {
	tag: string | null;
	/** Static classes and class: directives: name -> condition. */
	classes: Map<string, Cond>;
	/** class={…} (or class="a {b}"): any class may be present, tested at runtime. */
	class_js: string | null;
	id: string | null;
	attrs: Map<string, string | true>;
	/** C variable with this element's cuisv_pointer, when it computes one. */
	pointer: string | null;
	template: Template;
	/** Direction children are laid out in, when known. */
	dir: 'row' | 'column' | 'grid' | 'stack' | null;
}

export interface Layer {
	cond: Cond;
	facets: Facet[];
}

export interface ElementStyle {
	layers: Layer[];
	/** The element needs pointer state for its own or a descendant's :hover/:active rules. */
	needs_pointer: boolean;
}

export interface StyleResolver {
	/** Element info for an element about to be emitted. */
	info(node: AST.RegularElement | AST.Component, t: Template, ctx: CompileContext, tag: string | null): ElementInfo;
	/** Cascaded style of an element, given its ancestors (outermost first). */
	resolve(el: ElementInfo, ancestors: ElementInfo[]): ElementStyle;
	/** Style of :root (theme variables and the window background). */
	root(): ElementStyle;
	/** C that applies this component's :root rules to CUI's theme (each frame). */
	theme(): string[];
}

function attr_text(ctx: CompileContext, a: AST.Attribute): { static: string | null; js: string | null } {
	if (a.value === true) return { static: '', js: null };
	const parts = Array.isArray(a.value) ? a.value : [a.value];
	if (parts.every((p) => p.type === 'Text')) return { static: parts.map((p) => (p as AST.Text).data).join(''), js: null };
	const js = parts
		.map((p) => (p.type === 'Text' ? JSON.stringify(p.data) : `(${src(ctx, p.expression)})`))
		.join(' + " " + ');
	return { static: null, js };
}

export function create_style_resolver(ast: AST.Root, globals: GlobalRules | undefined, warnings: Warning[]): StyleResolver {
	const warned = new Set<string>();
	const warn = (m: string) => {
		if (warned.has(m)) return;
		warned.add(m);
		warnings.push({ code: 'css_unsupported', message: m });
	};
	const own = rules_of(ast, '', warn, false);
	const all = [...(globals ?? []).filter((g) => !own.some((o) => o.order === g.order)), ...own];
	const problems_warned = new Set<string>();

	function info(node: AST.RegularElement | AST.Component, t: Template, ctx: CompileContext, tag: string | null): ElementInfo {
		const classes = new Map<string, Cond>();
		let class_js: string | null = null;
		let id: string | null = null;
		const attrs = new Map<string, string | true>();
		for (const a of node.attributes) {
			if (a.type === 'Attribute') {
				const v = attr_text(ctx, a);
				if (a.name === 'class') {
					if (v.static !== null) for (const c of v.static.split(/\s+/).filter(Boolean)) classes.set(c, true);
					else class_js = v.js;
				} else if (a.name === 'id' && v.static !== null) id = v.static;
				else if (v.static !== null) attrs.set(a.name, v.static === '' && a.value === true ? true : v.static);
			} else if (a.type === 'ClassDirective') {
				classes.set(a.name, { js: `!!(${src(ctx, a.expression)})` });
			}
		}
		return { tag, classes, class_js, id, attrs, pointer: null, template: t, dir: null };
	}

	function class_cond(el: ElementInfo, name: string): Cond {
		const c = el.classes.get(name);
		let out: Cond = c ?? false;
		if (el.class_js) out = or(out, { js: `__cuisv_h.has_class(${el.class_js}, ${JSON.stringify(name)})` });
		return out;
	}

	/**
	 * Whether compound p can match el, as a condition. Pointer pseudo-classes read the C
	 * pointer state: the subject's own (a placeholder until its variable is named) or an
	 * ancestor's in the same template.
	 */
	function match_compound(p: Compound, el: ElementInfo, subject: ElementInfo, t: Template): Cond {
		if (p.tag === ':root') return false;
		if (p.tag && p.tag !== el.tag) return false;
		if (p.ids.length && !p.ids.every((x) => x === el.id)) return false;
		for (const a of p.attrs) {
			const v = el.attrs.get(a.name);
			if (v === undefined) return false;
			if (a.value !== null && v !== a.value) return false;
		}
		let cond: Cond = true;
		for (const c of p.classes) cond = and(cond, class_cond(el, c));
		if (cond === false) return false;
		for (const ps of p.pseudo) {
			let ptr: string;
			if (el === subject) ptr = '$POINTER';
			else if (el.pointer && el.template === t) ptr = el.pointer;
			else {
				if (el.template !== t) warn(`:${ps} on an element outside the block it styles is not supported`);
				return false;
			}
			const v = ps === 'hover' ? 'hovered' : ps === 'active' ? 'pressed' : ps === 'focus-visible' ? 'focus_visible' : 'focused';
			cond = and(cond, { c: `${ptr}.${v}` });
		}
		return cond;
	}

	/** Condition for selector parts[0..i] to match `el` with ancestors `anc`. */
	function match_from(parts: Compound[], i: number, el: ElementInfo, anc: ElementInfo[], subject: ElementInfo): Cond {
		const cond = match_compound(parts[i], el, subject, subject.template);
		if (cond === false || i === 0) return cond;
		const comb = parts[i].combinator;
		if (comb === '>') {
			const parent = anc[anc.length - 1];
			if (!parent) return false;
			return and(cond, match_from(parts, i - 1, parent, anc.slice(0, -1), subject));
		}
		let any: Cond = false;
		for (let k = anc.length - 1; k >= 0; k--) {
			any = or(any, match_from(parts, i - 1, anc[k], anc.slice(0, k), subject));
			if (any === true) break;
		}
		return and(cond, any);
	}

	function to_layers(matched: { rule: Rule; sel: Selector; cond: Cond }[]): Layer[] {
		matched.sort((x, y) => {
			for (let k = 0; k < 3; k++) if (x.sel.specificity[k] !== y.sel.specificity[k]) return x.sel.specificity[k] - y.sel.specificity[k];
			return x.rule.order - y.rule.order;
		});
		const layers: Layer[] = [];
		for (const m of matched) {
			const fs: Facet[] = [];
			for (const d of m.rule.decls) {
				if (d.property.startsWith('--')) continue;
				for (const [p, v] of expand(d.property, resolve_vars(d.value))) {
					const problems: CssProblem[] = [];
					fs.push(...facets_of(p, v, problems));
					for (const pr of problems) {
						const key = pr.message;
						if (problems_warned.has(key)) continue;
						problems_warned.add(key);
						warn(pr.message);
					}
				}
			}
			if (fs.length) layers.push({ cond: m.cond, facets: fs });
		}
		return layers;
	}

	// custom properties defined on :root, substituted at build time
	const vars = new Map<string, string>();
	for (const r of all) {
		if (!r.selectors.some((s) => is_root(s.parts))) continue;
		for (const d of r.decls) if (d.property.startsWith('--')) vars.set(d.property, d.value.trim());
	}
	function resolve_vars(v: string, depth = 0): string {
		if (depth > 8 || !v.includes('var(')) return v;
		return resolve_vars(
			v.replace(/var\(\s*(--[\w-]+)\s*(?:,\s*([^()]*(?:\([^()]*\))?[^()]*))?\)/g, (m, name: string, fallback?: string) => {
				if (vars.has(name)) return vars.get(name)!;
				if (/^--cui-/.test(name)) return m; // theme tokens stay as var() for the color parser
				return fallback ?? m;
			}),
			depth + 1
		);
	}

	return {
		info,
		resolve(el, ancestors) {
			const matched: { rule: Rule; sel: Selector; cond: Cond }[] = [];
			let needs_pointer = false;
			for (const rule of all) {
				for (const sel of rule.selectors) {
					let cond = match_from(sel.parts, sel.parts.length - 1, el, ancestors, el);
					if (cond !== false && rule.scheme) cond = and(cond, { c: rule.scheme === 'dark' ? 'cuisv_dark(ui)' : '!cuisv_dark(ui)' });
					if (cond !== false) matched.push({ rule, sel, cond });
					// this element hovered (in any position of a selector) decides something
					for (const p of sel.parts) {
						if (!p.pseudo.length) continue;
						if (match_compound({ ...p, pseudo: [] }, el, el, el.template) !== false) needs_pointer = true;
					}
				}
			}
			return { layers: to_layers(matched), needs_pointer };
		},
		theme() {
			const out: string[] = [];
			for (const r of own) {
				if (!r.selectors.some((x) => is_root(x.parts))) continue;
				const lines: string[] = [];
				for (const d of r.decls) {
					const l = theme_line(d.property, resolve_vars(d.value.trim()), warn);
					if (l) lines.push(l);
				}
				if (!lines.length) continue;
				const cond = r.scheme === 'dark' ? 'cuisv_dark(ui)' : r.scheme === 'light' ? '!cuisv_dark(ui)' : null;
				out.push(cond ? `if (${cond}) { ${lines.join(' ')} }` : lines.join(' '));
			}
			return out.length ? ['{ cui_theme *th = cui_theme_get(ui); (void)th;', ...out.map((l) => '    ' + l), '}'] : [];
		},
		root() {
			const matched: { rule: Rule; sel: Selector; cond: Cond }[] = [];
			for (const rule of all) {
				for (const sel of rule.selectors) {
					if (is_root(sel.parts)) matched.push({ rule, sel, cond: true });
				}
			}
			return { layers: to_layers(matched), needs_pointer: false };
		}
	};
}

const THEME_FLOATS: Record<string, string> = {
	'--cui-radius-control': 'radius_control',
	'--cui-radius-panel': 'radius_panel',
	'--cui-radius-surface': 'radius_surface',
	'--cui-control-sm': 'control_sm',
	'--cui-control-md': 'control_md',
	'--cui-control-lg': 'control_lg',
	'--cui-text-xs': 'text_xs',
	'--cui-text-sm': 'text_sm',
	'--cui-text-body': 'text_body',
	'--cui-text-lg': 'text_lg',
	'--cui-heading-1': 'heading[0]',
	'--cui-heading-2': 'heading[1]',
	'--cui-heading-3': 'heading[2]',
	'--cui-heading-4': 'heading[3]',
	'--cui-font-scale': 'font_scale',
	'--cui-motion': 'motion'
};

/** One :root declaration as a theme assignment (th is the cui_theme). */
function theme_line(property: string, value: string, warn: (m: string) => void): string | null {
	const p = property.toLowerCase();
	const color_of = (v: string) => {
		const c = parse_color(v);
		if (!c) {
			warn(`${p}: ${v} is not a color`);
			return null;
		}
		return 'token' in c ? `cui_token_color(ui, (cui_token)${c.token})` : `(cui_color){ ${c.r}, ${c.g}, ${c.b}, ${c.a} }`;
	};
	if (p in THEME_FLOATS) {
		const n = /^[\d.]+$/.test(value) ? parseFloat(value) : parse_length(value);
		if (n === null || !Number.isFinite(n)) return null;
		return `th->${THEME_FLOATS[p]} = ${Number.isInteger(n) ? n + '.0' : n}f;`;
	}
	const tok = /^--cui-([\w-]+)$/.exec(p);
	if (tok) {
		const i = TOKENS.indexOf(tok[1] as (typeof TOKENS)[number]);
		if (i < 0) {
			warn(`${p} is not a CUI theme variable`);
			return null;
		}
		const c = color_of(value);
		return c ? `th->colors[${i + 1}] = ${c};` : null;
	}
	if (p.startsWith('--')) return null;
	if (p === 'background' || p === 'background-color') {
		const c = color_of(value);
		return c ? `th->colors[1] = ${c};` : null;
	}
	if (p === 'color') {
		const c = color_of(value);
		return c ? `th->colors[5] = ${c};` : null;
	}
	if (p === 'font-size') {
		const n = parse_length(value);
		return n === null ? null : `th->text_body = ${Number.isInteger(n) ? n + '.0' : n}f;`;
	}
	return null;
}

/** Replaces the $POINTER placeholder of an element's own pseudo-class conditions. */
export function bind_pointer(style: ElementStyle, pointer: string) {
	const fix = (c: Cond): Cond => {
		if (typeof c === 'boolean') return c;
		if ('c' in c) return { c: c.c.replace('$POINTER', pointer) };
		if ('and' in c) return { and: c.and.map(fix) };
		if ('or' in c) return { or: c.or.map(fix) };
		return c;
	};
	for (const l of style.layers) l.cond = fix(l.cond);
}

export type { FacetValue };
